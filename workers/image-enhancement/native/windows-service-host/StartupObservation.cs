using System.Buffers.Binary;
using System.ComponentModel;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsServiceHost;

// Wire creation/write return are not receipt proof; false MayHaveOccurred never proves zero execution.
internal sealed record StartupGateCapture(string ContextSha256, string Stage, string? FailureStage, Exception? Failure,
    string? PreparedFrameBase64, bool PreparedWriteReturned, string? AckFrameBase64, bool AckValidated,
    string? AuthorizedFrameBase64, bool AuthorizedWriteReturned, bool AuthorizationMayHaveOccurred,
    string? FinalFrameBase64, bool FinalWriteReturned, bool Disarmed);

// One authenticated startup observation; SCM and receipt proof remain caller responsibilities.
internal sealed class StartupObservation : IDisposable
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly Context context;
    private readonly bool technical;
    private readonly PeerPin host;
    private readonly CancellationTokenSource canceled = new();
    private CancellationTokenSource? window;
    private NamedPipeClientStream? pipe;
    private PeerPin? caller, node;
    private string? preparedHash;
    private int used, disposed;
    private readonly object captureSync = new();
    private string stage = "created";
    private string? failureStage, preparedWire, ackWire, authorizedWire;
    private Exception? firstFailure;
    private bool preparedWriteReturned, ackValidated, authorizedWriteReturned, authorizationMayHaveOccurred;
    private static readonly byte[] PhasePrefix = "ZEB_WORKER_STARTUP_V1 "u8.ToArray();
    private readonly byte[] phaseLine = new byte[511];
    private readonly TaskCompletionSource phaseAvailable = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private JsonElement? sourcePhase;
    private int phaseLength;
    private bool discardPhaseLine, finalWriteReturned, disarmed;
    private string? finalWire;

    private StartupObservation(Context context, bool technical, PeerPin host)
    { this.context = context; this.technical = technical; this.host = host; }

    internal StartupGateCapture Capture
    {
        get
        {
            lock (captureSync) return new(context.SourceSha, stage, failureStage, firstFailure,
                preparedWire, preparedWriteReturned, ackWire, ackValidated,
                authorizedWire, authorizedWriteReturned, authorizationMayHaveOccurred,
                finalWire, finalWriteReturned, disarmed);
        }
    }
    private void Stage(string value) { lock (captureSync) stage = value; }
    internal string NodeArgument => "--startup-observation-v1=" + context.Attempt + ":" + context.Nonce;
    internal void RecordFailure(Exception failure)
    {
        lock (captureSync)
        {
            if (firstFailure is not null) return;
            firstFailure = failure;
            failureStage = stage;
        }
    }

    internal static StartupObservation CreateForService(string encoded)
    {
        using var identity = WindowsIdentity.GetCurrent();
        if (identity.ImpersonationLevel != TokenImpersonationLevel.None) throw Invalid();
        SecurityIdentifier service;
        try { service = (SecurityIdentifier)new NTAccount("NT SERVICE", "ZebImageEnhancement").Translate(typeof(SecurityIdentifier)); }
        catch (IdentityNotMappedException) { throw Invalid(); }
        if (identity.User is null || !service.Equals(identity.User)) throw Invalid();
        return Create(encoded, false, service.Value, 0);
    }

    // IVT-only: fixed actual current user/session, never supplied as a configurable principal.
    internal static StartupObservation CreateForTechnicalFixture(string encoded)
    {
        using var identity = WindowsIdentity.GetCurrent();
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        if (identity.ImpersonationLevel != TokenImpersonationLevel.None || identity.User is null) throw Invalid();
        return Create(encoded, true, identity.User.Value, checked((uint)process.SessionId));
    }

    private static StartupObservation Create(string encoded, bool technical, string user, uint session)
    {
        var context = Context.Parse(encoded);
        if (context.ServiceSid != user) throw Invalid();
        if (technical && (context.Caller.User != user || context.Caller.Session != session)) throw Invalid();
        PeerPin original = PeerPin.Open(Environment.ProcessId, null,
            Environment.ProcessPath ?? throw Invalid(), context.HostSha, user, session);
        try { context.Remaining(); return new(context, technical, original); }
        catch { original.Dispose(); throw; }
    }

    internal void BeforeAuthorize(JobProcess owner, string executable)
    {
        try
        {
            Stage("prepare");
            if (Interlocked.Exchange(ref used, 1) != 0 || Volatile.Read(ref disposed) != 0) throw Invalid();
            window = CancellationTokenSource.CreateLinkedTokenSource(canceled.Token);
            window.CancelAfter(context.Remaining());
            RequireAuthorizationWindow();
            var inspection = owner.Inspect();
            RequirePrepared(inspection);
            Stage("pin-node");
            node = PeerPin.Open(inspection.EngineIdentity.Pid, inspection.EngineIdentity.CreationFileTime,
                executable, context.NodeSha, host.User, host.Session);
            Stage("connect");
            // A single native open uses the service ACE's exact mask, without GENERIC_WRITE/CreatePipeInstance.
            SafePipeHandle handle = Native.CreateFileW(@"\\.\pipe\" + context.PipeName,
                0x0012019b, 0, IntPtr.Zero, 3, 0x40000000 | 0x00100000 | 0x00010000, IntPtr.Zero);
            try
            {
                Native.Check(!handle.IsInvalid);
                Native.Noninherited(handle);
                RequireAuthorizationWindow();
                pipe = new NamedPipeClientStream(PipeDirection.InOut, true, true, handle);
            }
            catch { handle.Dispose(); throw; }
            Native.Check(Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint pid));
            if (pid != context.Caller.Pid) throw Invalid();
            Stage("pin-caller");
            caller = PeerPin.Open(checked((int)pid), context.Caller.Creation, context.Caller.Image,
                context.Caller.ImageSha, context.Caller.User, context.Caller.Session);
            if (!technical) Native.RequirePipeSecurity(pipe.SafePipeHandle, context.Caller.User, context.ServiceSid);
            CheckOriginal(owner);
            byte[] prepared = Frame(new
            {
                v = 1, kind = "prepared", seq = 1, context.Nonce,
                operationId = context.Operation, startupAttemptId = context.Attempt, startingReceiptSha256 = context.ReceiptSha,
                host = host.Wire, node = node.Wire, jobName = owner.JobName,
                inventorySha256 = context.InventorySha, configSha256 = context.ConfigSha,
                engineManifestSha256 = context.EngineSha, hostSha256 = context.HostSha, nodeSha256 = context.NodeSha,
                inspection = new { inspection.ProcessSignaled, inspection.InOriginalJob, inspection.ActiveProcesses,
                    inspection.TotalProcesses, inspection.JobHandleFlags, inspection.ProcessHandleFlags, inspection.Authorized, inspection.Sealed }
            }, 8192);
            preparedHash = Hash(prepared);
            lock (captureSync) { preparedWire = Convert.ToBase64String(prepared); stage = "write-prepared"; }
            pipe.WriteAsync(prepared, window.Token).AsTask().GetAwaiter().GetResult();
            lock (captureSync) { preparedWriteReturned = true; stage = "read-ack"; }
            RequireAuthorizationWindow();
            using var ack = ReadFrame(1024);
            Stage("validate-ack");
            var value = ack.RootElement;
            Keys(value, ["v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node"]);
            if (Integer(value, "v") != 1 || Text(value, "kind") != "ack_prepared" || Integer(value, "seq") != 2 ||
                Text(value, "nonce") != context.Nonce || Text(value, "operationId") != context.Operation ||
                Text(value, "startupAttemptId") != context.Attempt || Text(value, "preparedSha256") != preparedHash ||
                !host.Matches(value.GetProperty("host")) || !node.Matches(value.GetProperty("node"))) throw Invalid();
            CheckOriginal(owner);
            lock (captureSync) { ackValidated = true; stage = "prepared-acknowledged"; }
        }
        catch (Exception failure) { RecordFailure(failure); throw; }
    }

    internal void RequireAuthorizationWindow()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        canceled.Token.ThrowIfCancellationRequested();
        context.Remaining();
    }

    private void CheckOriginal(JobProcess owner)
    {
        RequireAuthorizationWindow();
        host.RequireRunning(); caller!.RequireRunning(); node!.RequireRunning();
        var inspection = owner.Inspect();
        RequirePrepared(inspection);
        if (inspection.EngineIdentity.Pid != node.Pid || inspection.EngineIdentity.CreationFileTime != node.Creation) throw Invalid();
    }

    private static void RequirePrepared(JobProcessObservation value)
    {
        if (value.Authorized || value.Sealed || value.ProcessSignaled || !value.InOriginalJob || value.ActiveProcesses < 1 ||
            value.TotalProcesses < value.ActiveProcesses || (value.JobHandleFlags & 1) != 0 || (value.ProcessHandleFlags & 1) != 0) throw Invalid();
    }

    internal void PublishAuthorized(JobProcess owner)
    {
        lock (captureSync) { authorizationMayHaveOccurred = true; stage = "inspect-authorized"; }
        try
        {
            RequireAuthorizationWindow();
            host.RequireRunning(); caller!.RequireRunning();
            var actual = owner.Inspect();
            if (!actual.Authorized || actual.EngineIdentity.Pid != node!.Pid || actual.EngineIdentity.CreationFileTime != node.Creation) throw Invalid();
            byte[] authorized = Frame(new { v = 1, kind = "authorized", seq = 3, context.Nonce,
                operationId = context.Operation, startupAttemptId = context.Attempt, preparedSha256 = preparedHash,
                host = host.Wire, node = node.Wire, authorized = true }, 1024);
            lock (captureSync) { authorizedWire = Convert.ToBase64String(authorized); stage = "write-authorized"; }
            pipe!.WriteAsync(authorized, window!.Token).AsTask().GetAwaiter().GetResult();
            lock (captureSync) { authorizedWriteReturned = true; stage = "authorized-write-returned"; }
            RequireAuthorizationWindow();
        }
        catch (Exception failure) { RecordFailure(failure); throw; }
    }

    internal void ObserveStderr(ReadOnlySpan<byte> bytes)
    {
        lock (captureSync)
        {
            try
            {
                foreach (byte value in bytes)
                {
                    if (value == (byte)'\n')
                    {
                        if (!discardPhaseLine) ReadPhaseLine(phaseLine.AsSpan(0, phaseLength));
                        phaseLength = 0; discardPhaseLine = false;
                    }
                    else if (!discardPhaseLine)
                    {
                        if (phaseLength < phaseLine.Length) phaseLine[phaseLength++] = value;
                        else
                        {
                            if (phaseLine.AsSpan(0, phaseLength).StartsWith(PhasePrefix)) throw Invalid();
                            discardPhaseLine = true; phaseLength = 0;
                        }
                    }
                }
            }
            catch (Exception failure) { RecordFailure(failure); }
            if (sourcePhase is not null || firstFailure is not null) phaseAvailable.TrySetResult();
        }
    }

    private void ReadPhaseLine(ReadOnlySpan<byte> line)
    {
        if (!line.StartsWith(PhasePrefix)) return;
        if (sourcePhase is not null) throw Invalid();
        using var document = Document(line[PhasePrefix.Length..].ToArray(), 4);
        var value = document.RootElement;
        Keys(value, ["v", "kind", "attempt", "nonce", "phase", "runnerConstructed", "listenerSucceeded",
            "recoveryCalled", "claimEntered", "prepareEntered", "authorizeEntered"]);
        string phase = Text(value, "phase");
        if (Integer(value, "v") != 1 || Text(value, "kind") != "startup_phase" ||
            Text(value, "attempt") != context.Attempt || Text(value, "nonce") != context.Nonce ||
            phase is not ("listening" or "listener_bind_failed" or "store_schema_incompatible" or "unknown")) throw Invalid();
        foreach (string key in new[] { "runnerConstructed", "listenerSucceeded", "recoveryCalled", "claimEntered", "prepareEntered", "authorizeEntered" })
            if (value.GetProperty(key).ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw Invalid();
        if (phase != "unknown" &&
            (value.GetProperty("runnerConstructed").GetBoolean() != (phase != "store_schema_incompatible") ||
             value.GetProperty("listenerSucceeded").GetBoolean() != (phase == "listening") ||
             value.GetProperty("recoveryCalled").GetBoolean() || value.GetProperty("claimEntered").GetBoolean() ||
             value.GetProperty("prepareEntered").GetBoolean() || value.GetProperty("authorizeEntered").GetBoolean())) throw Invalid();
        sourcePhase = value.Clone();
    }

    internal void CompleteStderr()
    {
        lock (captureSync)
        {
            if (sourcePhase is null || phaseLine.AsSpan(0, phaseLength).StartsWith(PhasePrefix))
                RecordFailure(new EndOfStreamException("worker_startup_phase_missing_or_partial"));
            phaseAvailable.TrySetResult();
        }
    }

    internal async Task ObserveFinalAsync(Task<WorkerStartupSettlement> cleanup)
    {
        try
        {
            await phaseAvailable.Task.WaitAsync(window!.Token).ConfigureAwait(false);
            JsonElement phase;
            lock (captureSync) { if (firstFailure is not null) throw firstFailure; phase = sourcePhase ?? throw Invalid(); }
            string kind = Text(phase, "phase");
            if (kind == "unknown") throw Invalid();
            object frame;
            if (kind == "listening")
            {
                frame = new { v = 1, kind = "ready", seq = 4, context.Nonce, operationId = context.Operation,
                    startupAttemptId = context.Attempt, preparedSha256 = preparedHash, host = host.Wire, node = node!.Wire, phase };
            }
            else
            {
                var actual = await cleanup.WaitAsync(window.Token).ConfigureAwait(false);
                var root = actual.Cleanup.RootExit;
                frame = new { v = 1, kind = "settled", seq = 4, context.Nonce, operationId = context.Operation,
                    startupAttemptId = context.Attempt, preparedSha256 = preparedHash, host = host.Wire, node = node!.Wire, phase,
                    actual.JobName, actual.Sealed, actual.OwnerReleasedTreeActive, actual.ForceCalls, actual.FailureType,
                    actual.CleanupFailureCount, actual.OwnerReleaseCompleted,
                    cleanup = new { rootExit = root is null ? null : new {
                        identity = new { pid = root.Identity.Pid, creationFileTime = root.Identity.CreationFileTime.ToString(CultureInfo.InvariantCulture) }, root.ExitCode },
                        actual.Cleanup.TreeExit, actual.Cleanup.Stdout, actual.Cleanup.Stderr } };
            }
            RequireAuthorizationWindow(); host.RequireRunning(); caller!.RequireRunning();
            // Settled awaits the original stderr EOF, which may have invalidated the first phase.
            lock (captureSync) { if (firstFailure is not null) throw firstFailure; }
            byte[] raw = Frame(frame, 8192);
            lock (captureSync) { finalWire = Convert.ToBase64String(raw); stage = "write-final"; }
            await pipe!.WriteAsync(raw, window.Token).ConfigureAwait(false);
            lock (captureSync) { finalWriteReturned = true; disarmed = kind == "listening"; stage = "final-write-returned"; }
        }
        catch (Exception failure) { RecordFailure(failure); }
        finally
        {
            try { CloseTransport(); }
            catch (Exception failure) { RecordFailure(failure); }
        }
    }

    private JsonDocument ReadFrame(int maximum)
    {
        byte[] wire = new byte[checked(maximum + 4)];
        int received = 0;
        try
        {
            ReadTo(4);
            uint length = BinaryPrimitives.ReadUInt32LittleEndian(wire);
            if (length == 0 || length > maximum) throw Invalid();
            ReadTo(checked(4 + (int)length));
            return Document(wire.AsSpan(4, checked((int)length)).ToArray(), 8);
        }
        finally { lock (captureSync) ackWire = Convert.ToBase64String(wire, 0, received); }
        void ReadTo(int required)
        {
            while (received < required)
            {
                int count = pipe!.ReadAsync(wire.AsMemory(received, required - received), window!.Token)
                    .AsTask().GetAwaiter().GetResult();
                if (count == 0) throw new EndOfStreamException("worker_startup_observation_eof");
                received += count;
                RequireAuthorizationWindow();
            }
        }
    }

    internal void CancelPending()
    {
        try { canceled.Cancel(); }
        catch (ObjectDisposedException) when (Volatile.Read(ref disposed) != 0) { }
    }

    private void CloseTransport() => Interlocked.Exchange(ref pipe, null)?.Dispose();
    // The caller retains this instance through any Start exception; Dispose releases resources, not capture.
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        try { CancelPending(); }
        finally
        {
            try { CloseTransport(); }
            finally
            {
                try { caller?.Dispose(); }
                finally { try { node?.Dispose(); } finally { host.Dispose(); window?.Dispose(); canceled.Dispose(); } }
            }
        }
    }

    private static byte[] Frame(object value, int maximum)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        if (body.Length == 0 || body.Length > maximum) throw Invalid();
        byte[] raw = new byte[body.Length + 4]; BinaryPrimitives.WriteUInt32LittleEndian(raw, checked((uint)body.Length));
        body.CopyTo(raw, 4); return raw;
    }
    private static JsonDocument Document(byte[] raw, int depth)
    {
        JsonDocument? document = null;
        try
        {
            document = JsonDocument.Parse(Utf8.GetString(raw), new JsonDocumentOptions { MaxDepth = depth });
            Duplicates(document.RootElement);
            return document;
        }
        catch { document?.Dispose(); throw; }
    }
    private static void Duplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw Invalid();
                Duplicates(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array) foreach (var child in value.EnumerateArray()) Duplicates(child);
    }
    private static void Keys(JsonElement value, string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object ||
            !value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).SequenceEqual(names.Order(StringComparer.Ordinal))) throw Invalid();
    }
    private static string Text(JsonElement value, string key) =>
        value.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString()! : throw Invalid();
    private static long Integer(JsonElement value, string key) =>
        value.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out long result) ? result : throw Invalid();
    private static string Hash(ReadOnlySpan<byte> value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
    private static string FileHash(string path) { using var file = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant(); }
    private static InvalidDataException Invalid() => new("worker_startup_observation_invalid");

    private sealed record Caller(uint Pid, ulong Creation, string Image, string ImageSha, string User, uint Session);
    private sealed record Context(string Operation, string Attempt, string ReceiptSha, string PipeName, string Nonce, long Cutoff,
        Caller Caller, string ServiceSid, string InventorySha, string ConfigSha, string EngineSha, string HostSha, string NodeSha,
        string SourceSha)
    {
        internal int Remaining()
        {
            long remaining = checked(Cutoff - Environment.TickCount64);
            if (remaining <= 0 || remaining > int.MaxValue) throw new TimeoutException("worker_startup_observation_deadline");
            return checked((int)remaining);
        }
        internal static Context Parse(string encoded)
        {
            try
            {
                if (string.IsNullOrEmpty(encoded) || encoded.Length > 5464 ||
                    encoded.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_'))) throw Invalid();
                byte[] raw = Convert.FromBase64String(encoded.Replace('-', '+').Replace('_', '/') + new string('=', (4 - encoded.Length % 4) % 4));
                if (raw.Length == 0 || raw.Length > 4096 ||
                    Convert.ToBase64String(raw).TrimEnd('=').Replace('+', '-').Replace('/', '_') != encoded) throw Invalid();
                using var document = Document(raw, 6);
                var value = document.RootElement;
                Keys(value, ["v", "operationId", "startupAttemptId", "startingReceiptSha256", "pipeName", "nonce", "cutoffTick64",
                    "caller", "expectedServiceSid", "inventorySha256", "configSha256", "engineManifestSha256", "hostSha256", "nodeSha256"]);
                if (Integer(value, "v") != 1) throw Invalid();
                string operation = Uuid(Text(value, "operationId")), attempt = Uuid(Text(value, "startupAttemptId"));
                string leaf = Text(value, "pipeName");
                if (leaf != "zeb-worker-startup-v1-" + attempt.Replace("-", "")) throw Invalid();
                var peer = value.GetProperty("caller");
                Keys(peer, ["pid", "creationFileTime", "imagePath", "imageSha256", "tokenUserSid", "sessionId"]);
                long pid = Integer(peer, "pid"), session = Integer(peer, "sessionId");
                if (pid <= 0 || pid > int.MaxValue || session < 0 || session > uint.MaxValue) throw Invalid();
                string image = Text(peer, "imagePath");
                if (!Path.IsPathFullyQualified(image) || image.StartsWith(@"\\", StringComparison.Ordinal) || image.Contains('\0')) throw Invalid();
                var caller = new Caller(checked((uint)pid), Creation(Text(peer, "creationFileTime")), Path.GetFullPath(image),
                    Hex(Text(peer, "imageSha256")), Sid(Text(peer, "tokenUserSid")), checked((uint)session));
                return new(operation, attempt, Hex(Text(value, "startingReceiptSha256")), leaf, Hex(Text(value, "nonce")),
                    Integer(value, "cutoffTick64"), caller, Sid(Text(value, "expectedServiceSid")),
                    Hex(Text(value, "inventorySha256")), Hex(Text(value, "configSha256")), Hex(Text(value, "engineManifestSha256")),
                    Hex(Text(value, "hostSha256")), Hex(Text(value, "nodeSha256")), Hash(raw));
            }
            catch (Exception failure) when (failure is FormatException or JsonException or ArgumentException or OverflowException)
            { throw Invalid(); }
        }
        private static string Uuid(string value) =>
            Guid.TryParseExact(value, "D", out var parsed) && parsed != Guid.Empty && parsed.ToString("D") == value ? value : throw Invalid();
        private static string Hex(string value) =>
            value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f') ? value : throw Invalid();
        private static string Sid(string value) => new SecurityIdentifier(value).Value == value ? value : throw Invalid();
    }
    private static ulong Creation(string value) =>
        ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong result) && result > 0 &&
        result.ToString(CultureInfo.InvariantCulture) == value ? result : throw Invalid();

    private sealed class PeerPin(SafeProcessHandle handle, int pid, ulong creation, string user, uint session) : IDisposable
    {
        internal int Pid { get; } = pid;
        internal ulong Creation { get; } = creation;
        internal string User { get; } = user;
        internal uint Session { get; } = session;
        internal object Wire => new { pid = Pid, creationFileTime = Creation.ToString(CultureInfo.InvariantCulture) };
        internal bool Matches(JsonElement value)
        {
            Keys(value, ["pid", "creationFileTime"]);
            return Integer(value, "pid") == Pid && StartupObservation.Creation(Text(value, "creationFileTime")) == Creation;
        }
        internal static PeerPin Open(int pid, ulong? expectedCreation, string image, string hash, string user, uint session)
        {
            SafeProcessHandle handle = Native.OpenProcess(0x00101000, false, pid);
            try
            {
                Native.Check(!handle.IsInvalid); Native.Noninherited(handle);
                Native.Check(Native.GetProcessId(handle) == pid);
                Native.Check(Native.GetProcessTimes(handle, out ulong creation, out _, out _, out _));
                if (creation == 0 || (expectedCreation is not null && expectedCreation != creation)) throw Invalid();
                uint length = 32768; var path = new StringBuilder(checked((int)length));
                Native.Check(Native.QueryFullProcessImageNameW(handle, 0, path, ref length));
                if (!string.Equals(Path.GetFullPath(image), path.ToString(), StringComparison.OrdinalIgnoreCase) ||
                    FileHash(path.ToString()) != hash) throw Invalid();
                var token = Native.Token(handle);
                if (token.User != user || token.Session != session) throw Invalid();
                var pin = new PeerPin(handle, pid, creation, user, session);
                pin.RequireRunning(); return pin;
            }
            catch { handle.Dispose(); throw; }
        }
        internal void RequireRunning()
        {
            uint result = Native.WaitForSingleObject(handle, 0);
            if (result == 0) throw Invalid();
            Native.Check(result == 258);
        }
        public void Dispose() { handle.Dispose(); if (!handle.IsClosed) throw Invalid(); }
    }

    private static class Native
    {
        internal static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        internal static void Noninherited(SafeHandle handle)
        { Check(GetHandleInformation(handle, out uint flags)); if ((flags & 1) != 0) throw Invalid(); }
        internal static (string User, uint Session) Token(SafeProcessHandle process)
        {
            Check(OpenProcessToken(process, 8, out SafeFileHandle token));
            using (token)
            {
                Noninherited(token);
                if (GetTokenInformation(token, 1, IntPtr.Zero, 0, out uint length) || Marshal.GetLastWin32Error() != 122 ||
                    length < IntPtr.Size || length > 65536) throw Invalid();
                IntPtr buffer = Marshal.AllocHGlobal(checked((int)length));
                try
                {
                    Check(GetTokenInformation(token, 1, buffer, length, out uint returned));
                    if (returned < IntPtr.Size || returned > length) throw Invalid();
                    string user = new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
                    Check(GetTokenInformation(token, 12, buffer, sizeof(uint), out returned));
                    if (returned != sizeof(uint)) throw Invalid();
                    return (user, unchecked((uint)Marshal.ReadInt32(buffer)));
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        internal static void RequirePipeSecurity(SafePipeHandle pipe, string caller, string service)
        {
            uint error = GetSecurityInfo(pipe, ResourceType.KernelObject, 5, out _, out _, out _, out _, out IntPtr descriptor);
            if (error != 0) throw new Win32Exception(checked((int)error));
            try
            {
                uint length = GetSecurityDescriptorLength(descriptor);
                if (length == 0 || length > 65536) throw Invalid();
                byte[] bytes = new byte[checked((int)length)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
                var actual = new RawSecurityDescriptor(bytes, 0);
                const ControlFlags required = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected;
                if (actual.Owner?.Value != caller || (actual.ControlFlags & required) != required ||
                    actual.DiscretionaryAcl is not { Count: 2 } acl) throw Invalid();
                var expected = new Dictionary<string, int>(StringComparer.Ordinal) { [caller] = 0x001f019f, [service] = 0x0012019b };
                foreach (GenericAce entry in acl)
                {
                    if (entry is not CommonAce ace || ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None ||
                        ace.IsCallback || !expected.Remove(ace.SecurityIdentifier.Value, out int mask) || mask != ace.AccessMask) throw Invalid();
                }
                if (expected.Count != 0) throw Invalid();
            }
            finally { LocalFree(descriptor); }
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetProcessId(SafeProcessHandle handle);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetProcessTimes(SafeProcessHandle handle, out ulong creation, out ulong exit, out ulong kernel, out ulong user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryFullProcessImageNameW(SafeProcessHandle handle, uint flags, StringBuilder path, ref uint length);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
        [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(SafeFileHandle token, int kind, IntPtr buffer, uint length, out uint required);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafePipeHandle CreateFileW(string path, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("advapi32.dll")]
        private static extern uint GetSecurityInfo(SafePipeHandle pipe, ResourceType type, uint information,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    }
}
