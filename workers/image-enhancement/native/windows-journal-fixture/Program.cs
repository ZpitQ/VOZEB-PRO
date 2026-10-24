using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsJournalFixture;

internal static class Program
{
    internal static readonly UTF8Encoding Utf8 = new(false, true);
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    internal const string Unicode = "商品-\u0085中🙂文\"引号\nline\r\t\\";
    internal static string Self => Environment.ProcessPath ?? throw new InvalidOperationException("Fixture executable is unavailable.");
    internal static void Write(object value) => Console.WriteLine(JsonSerializer.Serialize(value, Json));
    internal static JsonElement Element(object value) => JsonSerializer.SerializeToElement(value, Json);
    internal static string Text(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new InvalidDataException("Missing private field.");
    internal static string Id() => Guid.NewGuid().ToString("N");
    internal static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
    internal static object Error(Exception error)
    {
        // Only our explicit probe tags may cross this diagnostic boundary.
        // Process.Start/BCL exception messages can contain executable paths.
        var stage = error.Data["fixtureProbeStage"] as string;
        if (stage is null && error is Win32Exception direct && direct.Message is "independent_evidence_open" or "independent_create_new") stage = direct.Message;
        var type = error.GetType().Name;
        var message = error is InvalidDataException ? error.Message : error is Win32Exception ? "independent_probe_failed" : "fixture_contract_failed";
        var nativeError = error is Win32Exception win32 ? (int?)win32.NativeErrorCode : null;
        var probe = error.Data["fixtureProbeEvidence"];
        if (error is AggregateException aggregate)
            return new { type, message, stage, nativeError, probe, causes = aggregate.InnerExceptions.Select(Error).ToArray() };
        return new { type, message, stage, nativeError, probe };
    }
    internal static object EncodingEvidence(Encoding encoding) => new { encoding.WebName, encoding.CodePage, encoderFallback = encoding.EncoderFallback.GetType().Name, decoderFallback = encoding.DecoderFallback.GetType().Name, preambleBytes = encoding.GetPreamble().Length };
    internal static object Result(JournalResult result) => new { status = result.Status.ToString(), snapshot = result.Snapshot, ownerPresent = result.Owner is not null, diagnostic = result.Diagnostic };
    internal static JournalScope Scope(string? ticket = null) => new(new(new("商品-中🙂文", 1, "fixture-owner", 7), ticket ?? "ticket-" + Id()), new string('a', 64));
    internal static string Key(JournalScope scope) => Convert.ToHexStringLower(SHA256.HashData(Utf8.GetBytes(scope.Target.LaunchTicket)));
    internal static string Marker(string root, JournalScope scope) => Path.Combine(root, Key(scope) + ".reserved");
    internal static string Reservation(string root, JournalScope scope) => Path.Combine(root, Key(scope) + ".reservation.json");
    internal static string Record(string root, JournalScope scope, string id) => Path.Combine(root, Key(scope) + ".record-" + id + ".json");

    private static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = Utf8;
        Console.OutputEncoding = Utf8;
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Real Windows is required.");
            if (args.Length == 6 && args[0] == "outer")
                return await Outer.RunAsync(args[1], args[2], int.Parse(args[3], CultureInfo.InvariantCulture), int.Parse(args[4], CultureInfo.InvariantCulture), args[5]);
            if (args.Length == 6 && args[0] == "harness")
                return await Harness.RunAsync(args[1], args[2], int.Parse(args[3], CultureInfo.InvariantCulture), int.Parse(args[4], CultureInfo.InvariantCulture), args[5]);
            if (args.Length == 1 && args[0] == "actor") return ActorHost.Run();
            throw new ArgumentException("Invalid private bootstrap.");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("fixture_failure/" + error.GetType().Name);
            return 1;
        }
    }
}

// The driver calls only public journal methods. The independently implemented
// Probe below never calls a production security/file verification helper.
internal static class ActorHost
{
    internal static int Run()
    {
        using var self = ProcessPin.Current();
        ProtectedJournal? owner = null;
        Program.Write(new { kind = "actor-ready", identity = self.Identity, nonInherited = self.NonInherited, sameSid = self.SameSid, inputEncoding = Program.EncodingEvidence(Console.InputEncoding), outputEncoding = Program.EncodingEvidence(Console.OutputEncoding), errorEncoding = Program.EncodingEvidence(Console.Error.Encoding) });
        try
        {
            while (Console.In.ReadLine() is { } line)
            {
                using var document = JsonDocument.Parse(line);
                var command = document.RootElement;
                var id = command.GetProperty("id").GetInt32();
                var op = Program.Text(command, "op");
                if (op == "exit") { Program.Write(new { kind = "reply", id, value = new { exiting = true } }); break; }
                var pause = command.TryGetProperty("pause", out var requested) ? requested.GetString() : null;
                var fault = command.TryGetProperty("fault", out var faultValue) ? Enum.Parse<JournalTestFault>(faultValue.GetString()!) : JournalTestFault.None;
                JournalTestControl.Fault = fault;
                JournalTestControl.Observer = (stage, original, selected) =>
                {
                    object? handles = null;
                    if (original is not null)
                    {
                        var originalIdentity = Probe.Identity(original);
                        var selectedIdentity = selected is null ? null : Probe.Identity(selected);
                        int? independentFailureError = null;
                        if (selected is not null && stage == JournalTestStage.BeforeWrite && fault == JournalTestFault.WriteReadOnly)
                            independentFailureError = Probe.TryWrite(selected).NativeError;
                        if (selected is not null && stage == JournalTestStage.BeforeFlush && fault == JournalTestFault.FlushReadOnly)
                            independentFailureError = Probe.TryFlush(selected).NativeError;
                        handles = new { originalIdentity, selectedIdentity, originalNonInherited = Probe.NonInherited(original), selectedNonInherited = selected is null ? (bool?)null : Probe.NonInherited(selected), selectedGrantedAccess = selected is null ? (uint?)null : Probe.GrantedAccess(selected), independentFailureError };
                    }
                    Program.Write(new { kind = "stage", id, stage = stage.ToString(), handles });
                    if (stage.ToString() == pause)
                    {
                        using var continuation = JsonDocument.Parse(Console.In.ReadLine() ?? throw new EndOfStreamException("Held-stage controller closed."));
                        Program.Require(continuation.RootElement.GetProperty("continue").GetBoolean(), "Held-stage continuation is invalid.");
                    }
                };
                object value;
                try
                {
                    var root = command.TryGetProperty("root", out var rootValue) ? rootValue.GetString()! : "";
                    var scope = command.TryGetProperty("scope", out var scopeValue) ? scopeValue.Deserialize<JournalScope>(Program.Json)! : null;
                    switch (op)
                    {
                        case "reserve":
                            var reserved = ProtectedJournal.Reserve(root, scope!, Program.Text(command, "executionId"));
                            owner = reserved.Owner;
                            value = Program.Result(reserved);
                            break;
                        case "inspect": value = Program.Result(ProtectedJournal.InspectReservation(root, scope!)); break;
                        case "read": value = Program.Result(ProtectedJournal.Read(root, scope!, Program.Text(command, "executionId"), Program.Text(command, "recordId"))); break;
                        case "publish":
                            Program.Require(owner is not null, "Private actor has no original owner.");
                            using (var payload = JsonDocument.Parse(Program.Text(command, "recordJson")))
                                value = Program.Result(owner!.Publish(Program.Text(command, "recordId"), payload.RootElement));
                            break;
                        case "dispose":
                            Program.Require(owner is not null, "Private actor has no owner to dispose.");
                            owner!.Dispose(); owner.Dispose(); value = new { doubleDisposeSucceeded = true }; break;
                        case "echo":
                            var text = Program.Text(command, "text");
                            Console.Error.WriteLine(JsonSerializer.Serialize(text, Program.Json));
                            value = new { text, base64 = Convert.ToBase64String(Program.Utf8.GetBytes(text)), inputEncoding = Program.EncodingEvidence(Console.InputEncoding), outputEncoding = Program.EncodingEvidence(Console.OutputEncoding) };
                            break;
                        default: throw new InvalidDataException("Invalid private operation.");
                    }
                }
                catch (Exception error)
                {
                    value = new { errorType = error is ArgumentException ? nameof(ArgumentException) : error.GetType().Name, nativeError = error is Win32Exception native ? (int?)native.NativeErrorCode : null };
                }
                finally { JournalTestControl.Observer = null; JournalTestControl.Fault = JournalTestFault.None; }
                Program.Write(new { kind = "reply", id, value });
            }
        }
        finally { owner?.Dispose(); }
        return 0;
    }
}

internal sealed record ProcessIdentity(uint Pid, string CreatedFileTime);

internal sealed class ProcessPin : IDisposable
{
    internal const uint RequiredTerminationAccess = 0x1;
    internal SafeFileHandle Handle { get; }
    internal ProcessIdentity Identity { get; }
    internal bool NonInherited => Probe.NonInherited(Handle);
    internal bool Alive => !Probe.Signaled(Handle);
    internal bool SameSid { get; }
    internal bool Joined { get; private set; }
    internal bool GuardMembershipVerified { get; private set; }
    internal uint? TerminationGrantedAccess { get; private set; }
    private bool terminationAttempted;
    private Win32Exception? terminationFailure;
    internal Win32Exception? ProvisionalTermination => terminationFailure is { NativeErrorCode: 5 } ? terminationFailure : null;
    internal int? ExitCode
    {
        get { if (Alive) return null; Probe.Check(Probe.GetExitCodeProcess(Handle, out var code), "process_exit_code"); return unchecked((int)code); }
    }
    private ProcessPin(SafeFileHandle handle)
    {
        Handle = handle;
        try
        {
            Probe.Check(!handle.IsInvalid, "process_handle");
            Identity = new(Probe.GetProcessId(handle), Probe.CreationTime(handle).ToString(CultureInfo.InvariantCulture));
            SameSid = Probe.ProcessSid(handle) == Probe.CurrentSid;
            Program.Require(Identity.Pid > 0 && NonInherited && SameSid, "Exact private process ownership failed.");
        }
        catch { handle.Dispose(); throw; }
    }
    internal static ProcessPin Current() => new(Probe.OpenProcess(0x00101101, false, (uint)Environment.ProcessId));
    internal static ProcessPin Duplicate(SafeProcessHandle original)
    {
        Probe.Check(Probe.DuplicateHandle(Probe.GetCurrentProcess(), original, Probe.GetCurrentProcess(), out var copy, 0, false, 2), "duplicate_original_process");
        return new(copy);
    }
    internal static ProcessPin Open(uint pid) => new(Probe.OpenProcess(0x00101001, false, pid));
    internal bool VerifyGuardMembership(SafeFileHandle ownedJob)
    {
        var member = Probe.InJob(Handle, ownedJob);
        if (member) GuardMembershipVerified = true;
        return member;
    }
    internal void Terminate()
    {
        if (terminationFailure is not null)
        {
            if (ProvisionalTermination is not null) return;
            throw terminationFailure;
        }
        if (terminationAttempted || !Alive) return;
        var originalHandleRetained = !Handle.IsInvalid && !Handle.IsClosed;
        var nonInherited = NonInherited;
        Program.Require(originalHandleRetained && GuardMembershipVerified && SameSid && nonInherited, "Exact private process termination ownership is unproven.");
        var grantedAccess = Probe.GrantedAccess(Handle);
        TerminationGrantedAccess = grantedAccess;
        var accessEvidence = new { identity = Identity, grantedAccess, requiredAccess = RequiredTerminationAccess, originalHandleRetained, membershipVerified = GuardMembershipVerified, nonInherited, sameSid = SameSid };
        if ((grantedAccess & RequiredTerminationAccess) == 0)
        {
            var error = new InvalidDataException("Retained private process lacks PROCESS_TERMINATE.");
            error.Data["fixtureProbeStage"] = "verify_private_process_terminate_access";
            error.Data["fixtureProbeEvidence"] = accessEvidence;
            throw error;
        }
        terminationAttempted = true;
        var terminated = Probe.TerminateProcess(Handle, 1);
        var nativeError = terminated ? 0 : Marshal.GetLastWin32Error();
        if (terminated) return;
        try { Probe.Check(false, "terminate_exact_private_process", new { identity = Identity, grantedAccess, requiredAccess = RequiredTerminationAccess, originalHandleRetained, membershipVerified = GuardMembershipVerified, nonInherited, sameSid = SameSid, terminationAttempted = true, terminationSucceeded = false }, capturedError: nativeError); }
        catch (Win32Exception error)
        {
            terminationFailure = error;
            if (error.NativeErrorCode != 5) throw;
            // This failed call remains provisional until final independent
            // join/Job/EOF/deadline proof. It is never attempted again.
        }
    }
    internal async Task WaitAsync(CancellationToken token) { await WaitOriginalAsync(Handle, token); Joined = true; }
    internal static async Task WaitOriginalAsync(SafeHandle original, CancellationToken token)
    {
        var retained = false;
        try
        {
            original.DangerousAddRef(ref retained);
            using var wait = new ProcessWait(original);
            await Probe.WaitAsync(wait, token);
            Program.Require(Probe.Signaled(original), "Original process handle did not signal after its native wait.");
        }
        finally { if (retained) original.DangerousRelease(); }
    }
    public void Dispose() => Handle.Dispose();
    private sealed class ProcessWait : WaitHandle
    {
        internal ProcessWait(SafeHandle handle) => SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), false);
    }
}

// Only Outer owns this non-inherited Job handle. Kill-on-close is containment;
// successful cleanup still requires actual retained-handle joins and active0.
internal sealed class OwnershipGuard : IDisposable
{
    private readonly SafeFileHandle job;
    private readonly Dictionary<ProcessIdentity, ProcessPin> observed = [];
    internal bool NonInherited { get; }
    internal bool OuterOutsideJob { get; }
    internal bool HostAssigned { get; private set; }
    internal OwnershipGuard()
    {
        job = Probe.CreateJobObjectW(IntPtr.Zero, null);
        Probe.Check(!job.IsInvalid, "guard_create");
        try
        {
            using var self = ProcessPin.Current();
            NonInherited = Probe.NonInherited(job);
            OuterOutsideJob = !Probe.InJob(self.Handle, job);
            Program.Require(OuterOutsideJob && NonInherited, "Independent outer Job ownership failed.");
            Probe.SetKillOnClose(job);
        }
        catch { job.Dispose(); throw; }
    }
    internal void AssignHost(SafeProcessHandle original)
    {
        Probe.Check(Probe.AssignProcessToJobObject(job, original), "guard_assign_original_host");
        var pin = ProcessPin.Duplicate(original);
        if (!pin.VerifyGuardMembership(job)) { pin.Dispose(); throw new InvalidDataException("Original child is outside the owned guard."); }
        if (!observed.TryAdd(pin.Identity, pin)) { pin.Dispose(); throw new InvalidDataException("Duplicate private process object."); }
        HostAssigned = true;
    }
    private ProcessPin[] Capture(CancellationToken token)
    {
        var members = Probe.JobMembers(job, token);
        Program.Require(!members.Contains((uint)Environment.ProcessId), "Outer unexpectedly entered its private Job.");
        foreach (var pid in members)
        {
            if (observed.Values.Any(pin => pin.Identity.Pid == pid)) continue;
            var pin = ProcessPin.Open(pid);
            if (!pin.VerifyGuardMembership(job)) { pin.Dispose(); throw new InvalidDataException("Unexpected process is outside the guard."); }
            if (!observed.TryAdd(pin.Identity, pin)) pin.Dispose();
        }
        return observed.Values.ToArray();
    }
    internal void RetainHeldActor(ProcessIdentity expected, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var matches = Capture(token).Where(pin => pin.Identity == expected).ToArray();
        Program.Require(matches.Length == 1, "Held Actor identity has no exact retained Job process handle.");
        var actor = matches[0];
        Program.Require(actor.Alive && actor.SameSid && actor.NonInherited && actor.VerifyGuardMembership(job), "Held Actor handle is not a verified live private Job member.");
        // Capture owns this actual handle until the independent cleanup
        // receipt. Host stdin EOF can no longer make its object unjoinable.
    }
    internal async Task ReclaimAsync(CancellationToken token)
    {
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var pins = Capture(token);
            var unjoined = pins.Where(pin => !pin.Joined).ToArray();
            var failures = new List<Exception>();
            foreach (var pin in pins) { try { pin.Terminate(); } catch (Exception error) { failures.Add(error); } }
            try { await Task.WhenAll(unjoined.Select(pin => pin.WaitAsync(token))); } catch (Exception error) { failures.Add(error); }
            if (failures.Count != 0) throw new AggregateException(failures);
            // The stopped original host cannot create more Actors. A requery
            // follows actual joins; a contradictory query fails without polling.
            if (Probe.JobMembers(job, token).Length == 0 && Probe.JobActive(job) == 0) return;
            Program.Require(unjoined.Length != 0, "Private Job remained active without a new joinable member.");
        }
    }
    internal object Evidence(CancellationToken token, List<object> failures, bool originalHostJoined, bool originalHostStreamsEof, long cleanupDeadlineTick)
    {
        var pins = observed.Values.ToArray();
        var provisional = pins.Where(pin => pin.ProvisionalTermination is not null).ToArray();
        try
        {
            token.ThrowIfCancellationRequested();
            Program.Require(Environment.TickCount64 <= cleanupDeadlineTick, "Absolute private cleanup deadline elapsed before final proof.");
            var members = Probe.JobMembers(job, token);
            var activeProcesses = Probe.JobActive(job);
            var processes = pins.Select(pin => new { identity = pin.Identity, alive = pin.Alive, joined = pin.Joined, nonInherited = pin.NonInherited, sameSid = pin.SameSid, membershipVerified = pin.GuardMembershipVerified, terminationGrantedAccess = pin.TerminationGrantedAccess }).ToArray();
            var allObservedJoined = activeProcesses == 0 && members.Length == 0 && processes.All(process => process.joined && !process.alive);
            token.ThrowIfCancellationRequested();
            var proofTick = Environment.TickCount64;
            Program.Require(proofTick <= cleanupDeadlineTick, "Absolute private cleanup deadline elapsed before final proof.");
            var globalQualification = originalHostJoined && originalHostStreamsEof && allObservedJoined && HostAssigned && NonInherited && OuterOutsideJob;
            var resolvedTerminations = new List<object>();
            foreach (var pin in provisional)
            {
                var process = processes.Single(value => value.identity == pin.Identity);
                var qualified = globalQualification && process.joined && !process.alive && process.membershipVerified && process.nonInherited && process.sameSid && pin.TerminationGrantedAccess is { } access && (access & ProcessPin.RequiredTerminationAccess) != 0 && !pin.Handle.IsInvalid && !pin.Handle.IsClosed;
                if (qualified)
                    resolvedTerminations.Add(new { error = Program.Error(pin.ProvisionalTermination!), identity = pin.Identity, grantedAccess = pin.TerminationGrantedAccess, requiredAccess = ProcessPin.RequiredTerminationAccess, terminationSucceeded = false, originalJoined = process.joined, signaled = !process.alive, activeProcesses, memberCount = members.Length, originalHostJoined, originalHostStreamsEof, proofTick, cleanupDeadlineTick });
                else failures.Add(new { stage = "independent-process-termination-unresolved", error = Program.Error(pin.ProvisionalTermination!) });
            }
            return new { failures, resolvedTerminations, activeProcesses, liveOwnedProcesses = processes.Where(process => process.alive).Select(process => process.identity).ToArray(), allObservedJoined, membershipVerified = HostAssigned, nonInherited = NonInherited, outerOutsideJob = OuterOutsideJob, soleJobHandle = true, killOnClose = true, processes };
        }
        catch (Exception error)
        {
            if (provisional.Length != 0) throw new AggregateException(new[] { error }.Concat(provisional.Select(pin => (Exception)pin.ProvisionalTermination!)));
            throw;
        }
    }
    public void Dispose() { foreach (var pin in observed.Values) pin.Dispose(); job.Dispose(); }
}

internal sealed class Outer : IDisposable
{
    private readonly Process host;
    private readonly StreamReader input = new(Console.OpenStandardInput(), Program.Utf8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
    private readonly int cleanupMs;
    private readonly object gate = new();
    private readonly TaskCompletionSource<JsonElement> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<JsonElement> receipt = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<long> cleanupStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<Exception> fatal = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<object> protocolFailures = [];
    private readonly List<string> stderr = [];
    private Task stdoutTask = Task.CompletedTask;
    private Task stderrTask = Task.CompletedTask;
    private Task hostExit = Task.CompletedTask;
    private SafeProcessHandle? originalHandle;
    private ProcessIdentity? originalIdentity;
    private object? primaryFailure;
    private JsonElement? bootstrapFailure;
    private JsonElement? heldPhase;
    private bool started;
    private bool hostJoined;
    private bool stdoutEof;
    private bool stderrEof;
    private string? stdoutError;
    private string? stderrError;
    private int? hostExitCode;
    private long cleanupDeadlineTick;
    private long cleanupDeadlineUnixMs;
    private bool scenarioForwarded;
    private bool readyForwarded;

    private Outer(string ordinary, string directory, int executionMs, int cleanupMs, string control)
    {
        this.cleanupMs = cleanupMs;
        var start = new ProcessStartInfo(Program.Self) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = Program.Utf8, StandardOutputEncoding = Program.Utf8, StandardErrorEncoding = Program.Utf8 };
        foreach (var argument in new[] { "harness", ordinary, directory, executionMs.ToString(CultureInfo.InvariantCulture), cleanupMs.ToString(CultureInfo.InvariantCulture), control == "host-before-ready" ? control : "none" }) start.ArgumentList.Add(argument);
        host = new Process { StartInfo = start };
    }
    private void BeginCleanup(long? hostDeadlineTick = null, long? requestedUnixMs = null)
    {
        lock (gate)
        {
            var now = Environment.TickCount64;
            var deadline = hostDeadlineTick ?? checked(now + cleanupMs);
            if (requestedUnixMs is { } requested)
                deadline = checked(now + Math.Clamp(requested - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), 0, cleanupMs));
            Program.Require(deadline <= checked(now + cleanupMs), "Private host requested a larger cleanup budget.");
            if (cleanupDeadlineTick != 0 && cleanupDeadlineTick <= deadline) return;
            cleanupDeadlineTick = deadline;
            cleanupDeadlineUnixMs = checked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Math.Max(0, deadline - now));
            Program.Write(new { kind = "outer-cleanup-start", deadlineUnixMs = cleanupDeadlineUnixMs });
            cleanupStarted.TrySetResult(deadline);
        }
    }
    private void ProtocolFailure(Exception error)
    {
        lock (gate) protocolFailures.Add(Program.Error(error));
        fatal.TrySetResult(error);
    }
    private async Task DrainStdoutAsync(OwnershipGuard guard, CancellationToken executionToken)
    {
        try
        {
            while (await host.StandardOutput.ReadLineAsync() is { } line)
            {
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var frame = document.RootElement.Clone();
                    switch (Program.Text(frame, "kind"))
                    {
                        case "harness-ready":
                            Program.Require(ready.TrySetResult(frame), "Duplicate private host ready.");
                            break;
                        case "host-cleanup-start":
                            BeginCleanup(hostDeadlineTick: frame.GetProperty("deadlineTick").GetInt64());
                            break;
                        case "receipt":
                            Program.Require(cleanupStarted.Task.IsCompleted && receipt.TrySetResult(frame.GetProperty("value").Clone()), "Uncorrelated private host receipt.");
                            break;
                        case "host-bootstrap-failure":
                            bootstrapFailure = frame;
                            fatal.TrySetResult(new InvalidDataException("private_host_before_ready"));
                            break;
                        case "host-held":
                            Program.Require(readyForwarded && scenarioForwarded && heldPhase is null, "Private held frame preceded the assignment barrier.");
                            Program.Require(Program.Text(frame, "phase") == "registered-actor-loaded" && frame.GetProperty("registered").GetBoolean(), "Private held phase is not a registered loaded Actor.");
                            var heldIdentity = frame.GetProperty("actor").GetProperty("identity").Deserialize<ProcessIdentity>(Program.Json) ?? throw new InvalidDataException("Private held Actor has no creation identity.");
                            guard.RetainHeldActor(heldIdentity, executionToken);
                            heldPhase = frame;
                            Program.Write(new { kind = "outer-held", value = frame });
                            break;
                        default: throw new InvalidDataException("Unknown private host frame.");
                    }
                }
                catch (Exception error) { ProtocolFailure(error); }
                // Continue draining after a protocol failure. A parser failure
                // does not manufacture EOF or cancel ownership of this stream.
            }
            stdoutEof = true;
        }
        catch (Exception error) { stdoutError = error.GetType().Name; ProtocolFailure(error); }
    }
    private async Task DrainStderrAsync()
    {
        try { while (await host.StandardError.ReadLineAsync() is { } line) lock (gate) stderr.Add(line); stderrEof = true; }
        catch (Exception error) { stderrError = error.GetType().Name; ProtocolFailure(error); }
    }
    private async Task<T> AwaitHostAsync<T>(Task<T> expected, CancellationToken token)
    {
        var completed = await Task.WhenAny(expected, fatal.Task, hostExit).WaitAsync(token);
        if (fatal.Task.IsCompleted) throw await fatal.Task;
        if (completed == expected) return await expected;
        // Signal can precede the last pipe frame. Read actual EOF before
        // deciding that a ready/receipt was absent from the exited host.
        await stdoutTask.WaitAsync(token);
        if (fatal.Task.IsCompleted) throw await fatal.Task;
        if (expected.IsCompleted) return await expected;
        throw new InvalidDataException("Private host exited before the expected frame.");
    }
    private async Task SendAsync(string line, CancellationToken token)
    {
        await host.StandardInput.WriteLineAsync(line.AsMemory(), token);
        await host.StandardInput.FlushAsync(token);
    }
    private async Task<JsonElement> AwaitReceiptAsync(Task<string?> closeInput, CancellationToken executionToken)
    {
        while (true)
        {
            using var cleanupWait = cleanupDeadlineTick == 0 ? null : new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupDeadlineTick - Environment.TickCount64)));
            var token = cleanupWait?.Token ?? executionToken;
            var choices = cleanupWait is null ? new Task[] { receipt.Task, fatal.Task, hostExit, closeInput, cleanupStarted.Task } : new Task[] { receipt.Task, fatal.Task, hostExit, closeInput };
            var completed = await Task.WhenAny(choices).WaitAsync(token);
            if (fatal.Task.IsCompleted) throw await fatal.Task;
            if (completed == receipt.Task) return await receipt.Task;
            if (completed == cleanupStarted.Task) continue;
            if (completed == closeInput)
            {
                var line = await closeInput;
                if (line is not null)
                {
                    using var request = JsonDocument.Parse(line);
                    Program.Require(request.RootElement.GetProperty("close").GetBoolean(), "Unexpected second private command.");
                    BeginCleanup(requestedUnixMs: request.RootElement.GetProperty("cleanupDeadlineUnixMs").GetInt64());
                }
                else BeginCleanup();
                throw new InvalidDataException("private_host_explicit_close");
            }
            return await AwaitHostAsync(receipt.Task, token);
        }
    }
    private void TerminateOriginalHost()
    {
        if (!started || hostJoined) return;
        if (originalHandle is null) host.Kill();
        else if (!Probe.Signaled(originalHandle))
        {
            var terminated = Probe.TerminateProcess(originalHandle, 1);
            var nativeError = terminated ? 0 : Marshal.GetLastWin32Error();
            if (!terminated && !Probe.Signaled(originalHandle)) Probe.Check(false, "terminate_original_host", capturedError: nativeError);
        }
    }
    internal static async Task<int> RunAsync(string ordinary, string directory, int executionMs, int cleanupMs, string control)
    {
        Program.Require(executionMs > 0 && cleanupMs > 0 && control is "none" or "close-nonzero" or "host-before-ready", "Unknown private outer control or budget.");
        using var guard = new OwnershipGuard();
        using var outer = new Outer(ordinary, directory, executionMs, cleanupMs, control);
        return await outer.RunOwnedAsync(guard, executionMs, control);
    }
    private async Task<int> RunOwnedAsync(OwnershipGuard guard, int executionMs, string control)
    {
        JsonElement? hostReceipt = null;
        var cleanupFailures = new List<object>();
        var forced = false;
        using var execution = new CancellationTokenSource(executionMs);
        try
        {
            Program.Require(host.Start(), "Could not launch original private host.");
            started = true;
            stdoutTask = DrainStdoutAsync(guard, execution.Token);
            stderrTask = DrainStderrAsync();
            originalHandle = host.SafeHandle;
            hostExit = ProcessPin.WaitOriginalAsync(originalHandle, CancellationToken.None);
            originalIdentity = new(Probe.GetProcessId(originalHandle), Probe.CreationTime(originalHandle).ToString(CultureInfo.InvariantCulture));
            guard.AssignHost(originalHandle);
            // Even the bootstrap fault is released only after assignment;
            // this command cannot launch Actors or authorize a scenario.
            if (control == "host-before-ready") await SendAsync("{\"bootstrap\":true}", execution.Token);
            var hostReady = await AwaitHostAsync(ready.Task, execution.Token);
            Program.Require(hostReady.GetProperty("identity").Deserialize<ProcessIdentity>(Program.Json) == originalIdentity && hostReady.GetProperty("selfHandleNonInherited").GetBoolean() && hostReady.GetProperty("sameSid").GetBoolean() && hostReady.GetProperty("actorLaunches").GetInt32() == 0, "Original host ready identity differs.");
            readyForwarded = true;
            Program.Write(new { kind = "outer-ready", host = hostReady, hostMembershipVerified = guard.HostAssigned, guardHandleNonInherited = guard.NonInherited, outerOutsideJob = guard.OuterOutsideJob });
            var command = await AwaitHostAsync(input.ReadLineAsync(execution.Token).AsTask(), execution.Token);
            if (command is null) throw new InvalidDataException("private_host_explicit_close");
            using (var parsed = JsonDocument.Parse(command))
            {
                if (parsed.RootElement.TryGetProperty("close", out var close) && close.GetBoolean())
                {
                    BeginCleanup(requestedUnixMs: parsed.RootElement.GetProperty("cleanupDeadlineUnixMs").GetInt64());
                    throw new InvalidDataException("private_host_explicit_close");
                }
                Program.Text(parsed.RootElement, "scenario");
            }
            scenarioForwarded = true;
            await SendAsync(command, execution.Token);
            hostReceipt = await AwaitReceiptAsync(input.ReadLineAsync(), execution.Token);
        }
        catch (Exception error)
        {
            primaryFailure = bootstrapFailure is { } bootstrap ? bootstrap.GetProperty("error").Clone() : Program.Error(error);
            forced = true;
        }

        BeginCleanup();
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupDeadlineTick - Environment.TickCount64)));
        if (forced)
        {
            try { TerminateOriginalHost(); } catch (Exception error) { cleanupFailures.Add(new { stage = "original-host-terminate", error = Program.Error(error) }); }
        }
        if (started)
        {
            try { host.StandardInput.Close(); } catch (Exception error) { cleanupFailures.Add(new { stage = "original-host-input-close", error = Program.Error(error) }); }
            try
            {
                await hostExit.WaitAsync(cleanup.Token);
                Program.Require(originalHandle is not null && Probe.Signaled(originalHandle), "Original host signal is unproven.");
                hostJoined = true;
                hostExitCode = host.ExitCode;
                if (hostExitCode != 0 && primaryFailure is null) primaryFailure = Program.Error(new InvalidDataException("Private host exited abnormally."));
            }
            catch (Exception error)
            {
                cleanupFailures.Add(new { stage = "original-host-join", error = Program.Error(error) });
                // No second grace period. This is containment if the same
                // absolute deadline no longer permits an actual join.
                try { TerminateOriginalHost(); } catch (Exception terminateError) { cleanupFailures.Add(new { stage = "original-host-final-terminate", error = Program.Error(terminateError) }); }
            }
        }
        try
        {
            Program.Require(!started || hostJoined, "Host join is required before exact Job discovery.");
            await guard.ReclaimAsync(cleanup.Token);
        }
        catch (Exception error) { cleanupFailures.Add(new { stage = "independent-job-reclaim", error = Program.Error(error) }); }
        try
        {
            await Task.WhenAll(stdoutTask, stderrTask).WaitAsync(cleanup.Token);
            Program.Require(!started || (stdoutEof && stderrEof && stdoutError is null && stderrError is null), "Actual original host stream EOF is unproven.");
        }
        catch (Exception error) { cleanupFailures.Add(new { stage = "original-host-streams", error = Program.Error(error) }); }
        object jobEvidence;
        try
        {
            jobEvidence = guard.Evidence(cleanup.Token, cleanupFailures, hostJoined, stdoutEof && stderrEof && stdoutError is null && stderrError is null, cleanupDeadlineTick);
        }
        catch (Exception error)
        {
            cleanupFailures.Add(new { stage = "independent-job-final-query", error = Program.Error(error) });
            jobEvidence = new { failures = cleanupFailures, activeProcesses = (uint?)null, liveOwnedProcesses = new[] { new { unknown = true } }, allObservedJoined = false, membershipVerified = false, nonInherited = guard.NonInherited, outerOutsideJob = guard.OuterOutsideJob, soleJobHandle = true, killOnClose = true, processes = Array.Empty<object>() };
        }
        Program.Write(new { kind = "outer-receipt", value = new { control, host = hostReceipt, outer = new { primaryFailure, protocolFailures, forced, readyForwarded, firstScenarioForwarded = scenarioForwarded, firstCommandBarrier = true, bootstrapFailure, heldPhase, cleanup = jobEvidence, cleanupDeadlineUnixMs, host = new { identity = originalIdentity, started, originalRetained = originalHandle is not null, originalJoined = hostJoined, exitCode = hostExitCode, stdoutEof, stderrEof, stdoutError, stderrError, stderr } } } });
        return control == "close-nonzero" || cleanupFailures.Count != 0 ? 1 : 0;
    }
    public void Dispose() { input.Dispose(); host.Dispose(); }
}

internal sealed class Actor : IDisposable
{
    private readonly Process process;
    private readonly SemaphoreSlim writes = new(1);
    private readonly SemaphoreSlim changed = new(0);
    private readonly object gate = new();
    private readonly TaskCompletionSource<JsonElement> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Dictionary<int, TaskCompletionSource<JsonElement>> pending = [];
    private readonly List<JsonElement> frames = [];
    private readonly List<string> stderr = [];
    private Task stdoutTask = Task.CompletedTask;
    private Task stderrTask = Task.CompletedTask;
    private SafeProcessHandle? originalHandle;
    private ProcessPin? pin;
    private ProcessIdentity? originalIdentity;
    private bool started;
    private bool joined;
    private bool terminationRequested;
    private bool? originalNonInherited;
    private bool? originalSameSid;
    private int? exitCode;
    private object? startupFailure;
    private int sequence;
    private string? stdoutError;
    private string? stderrError;
    private bool stdoutEof;
    private bool stderrEof;
    internal ProcessPin Pin => pin ?? throw new InvalidDataException("Private actor has no verified pin.");
    internal object? Encodings { get; private set; }
    internal bool Joined => !started || joined;
    internal bool StreamsJoined => !started || (stdoutTask.IsCompleted && stderrTask.IsCompleted && stdoutEof && stderrEof && stdoutError is null && stderrError is null);
    internal Actor(string directory)
    {
        var start = new ProcessStartInfo(Program.Self) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = Program.Utf8, StandardOutputEncoding = Program.Utf8, StandardErrorEncoding = Program.Utf8 };
        start.ArgumentList.Add("actor");
        process = new Process { StartInfo = start };
    }
    internal void Start(bool failBeforePin = false)
    {
        try
        {
            Program.Require(process.Start(), "Could not launch private journal actor.");
            started = true;
            // Start real drains before any retention/identity probe can throw.
            // RunContext already owns this exact Actor and original Process.
            stdoutTask = DrainStdoutAsync();
            stderrTask = DrainStderrAsync();
            originalHandle = process.SafeHandle;
            originalIdentity = new(Probe.GetProcessId(originalHandle), Probe.CreationTime(originalHandle).ToString(CultureInfo.InvariantCulture));
            originalNonInherited = Probe.NonInherited(originalHandle);
            originalSameSid = Probe.ProcessSid(originalHandle) == Probe.CurrentSid;
            Encodings = new { input = Program.EncodingEvidence(process.StandardInput.Encoding), output = Program.EncodingEvidence(process.StandardOutput.CurrentEncoding), error = Program.EncodingEvidence(process.StandardError.CurrentEncoding) };
            if (failBeforePin) throw new InvalidDataException("private_actor_retention_before_pin");
            pin = ProcessPin.Duplicate(originalHandle);
            Program.Require(pin.Identity == originalIdentity && originalNonInherited == true && originalSameSid == true, "Original Actor retention differs from its process handle.");
        }
        catch (Exception error) { startupFailure = Program.Error(error); throw; }
    }
    private async Task DrainStdoutAsync()
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                using var document = JsonDocument.Parse(line);
                var frame = document.RootElement.Clone();
                lock (gate)
                {
                    frames.Add(frame);
                    var kind = Program.Text(frame, "kind");
                    if (kind == "actor-ready") ready.TrySetResult(frame);
                    else if (kind == "reply")
                    {
                        var id = frame.GetProperty("id").GetInt32();
                        if (!pending.Remove(id, out var reply)) throw new InvalidDataException("Uncorrelated private actor reply.");
                        reply.TrySetResult(frame.GetProperty("value").Clone());
                    }
                    else Program.Require(kind == "stage", "Unknown private actor frame.");
                }
                changed.Release();
            }
            stdoutEof = true;
        }
        catch (Exception error) { stdoutError = error.GetType().Name; }
        finally
        {
            ready.TrySetException(new EndOfStreamException("Private actor closed before ready."));
            lock (gate) foreach (var item in pending.Values) item.TrySetException(new EndOfStreamException("Private actor closed before reply."));
            changed.Release();
        }
    }
    private async Task DrainStderrAsync()
    {
        try { while (await process.StandardError.ReadLineAsync() is { } line) lock (gate) stderr.Add(line); stderrEof = true; }
        catch (Exception error) { stderrError = error.GetType().Name; }
    }
    internal async Task<JsonElement> LoadedAsync(CancellationToken token)
    {
        var value = await ready.Task.WaitAsync(token);
        var identity = value.GetProperty("identity").Deserialize<ProcessIdentity>(Program.Json);
        Program.Require(identity == Pin.Identity && value.GetProperty("nonInherited").GetBoolean() && value.GetProperty("sameSid").GetBoolean(), "Actor ready differs from original process handle.");
        return value;
    }
    internal async Task WriteAsync(object command, CancellationToken token)
    {
        await writes.WaitAsync(token);
        try { await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(command, Program.Json).AsMemory(), token); await process.StandardInput.FlushAsync(token); }
        finally { writes.Release(); }
    }
    internal async Task<JsonElement> CallAsync(string op, object? fields, CancellationToken token)
    {
        var command = fields is null ? new JsonObject() : JsonSerializer.SerializeToNode(fields, Program.Json)!.AsObject();
        var id = Interlocked.Increment(ref sequence);
        command["op"] = op; command["id"] = id;
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate) pending.Add(id, completion);
        await WriteAsync(command, token);
        return await completion.Task.WaitAsync(token);
    }
    internal async Task<JsonElement> StageAsync(string stage, CancellationToken token, int after = 0)
    {
        while (true)
        {
            lock (gate)
            {
                var found = frames.Skip(after).FirstOrDefault(frame => Program.Text(frame, "kind") == "stage" && Program.Text(frame, "stage") == stage);
                if (found.ValueKind != JsonValueKind.Undefined) return found;
                if (stdoutEof || stdoutError is not null) throw new EndOfStreamException("Private actor closed before held stage.");
            }
            await changed.WaitAsync(token);
        }
    }
    internal JsonElement[] Frames { get { lock (gate) return frames.ToArray(); } }
    internal bool HasReply => Frames.Any(frame => Program.Text(frame, "kind") == "reply");
    internal string[] Stderr { get { lock (gate) return stderr.ToArray(); } }
    internal async Task ReleaseAsync(CancellationToken token) => await WriteAsync(new { @continue = true }, token);
    private async Task JoinOriginalAsync(CancellationToken token)
    {
        if (!started) return;
        Program.Require(originalHandle is not null, "Original Actor handle was not retained for its join.");
        await ProcessPin.WaitOriginalAsync(originalHandle!, token);
        Program.Require(Probe.Signaled(originalHandle!), "Original Actor did not signal after its join.");
        joined = true;
        Probe.Check(Probe.GetExitCodeProcess(originalHandle!, out var code), "original_actor_exit_code");
        exitCode = unchecked((int)code);
        if (pin is not null) await pin.WaitAsync(token);
    }
    internal void TerminateOriginal()
    {
        if (!started || joined) return;
        terminationRequested = true;
        if (originalHandle is null) process.Kill();
        else if (!Probe.Signaled(originalHandle))
        {
            var terminated = Probe.TerminateProcess(originalHandle, 1);
            var nativeError = terminated ? 0 : Marshal.GetLastWin32Error();
            if (!terminated && !Probe.Signaled(originalHandle)) Probe.Check(false, "terminate_original_actor", capturedError: nativeError);
        }
    }
    internal async Task CleanupAsync(CancellationToken token) { if (!started) return; await JoinOriginalAsync(token); await DrainAsync(token); }
    internal async Task ExitAsync(CancellationToken token) { await CallAsync("exit", null, token); await CleanupAsync(token); }
    internal async Task KillAsync(CancellationToken token) { TerminateOriginal(); await CleanupAsync(token); }
    internal async Task DrainAsync(CancellationToken token) => await Task.WhenAll(stdoutTask, stderrTask).WaitAsync(token);
    // Cached lifecycle facts remain serializable even when Start/Pin failed.
    // An unjoined started Actor stays conservatively live in the receipt.
    internal object Snapshot() => new { identity = originalIdentity, alive = started && !joined, exitCode, started, originalRetained = originalHandle is not null, originalJoined = joined, pinRetained = pin is not null, terminationRequested, nonInherited = originalNonInherited, sameSid = originalSameSid, startupFailure, stdoutEof, stderrEof, stdoutError, stderrError, frames = Frames, stderr = Stderr, encodings = Encodings };
    public void Dispose() { pin?.Dispose(); process.Dispose(); writes.Dispose(); changed.Dispose(); }
}

internal sealed class RunContext(string directory, string ordinary)
{
    internal readonly List<Actor> Actors = [];
    internal readonly Dictionary<string, object> Values = [];
    internal object? ReservationResult;
    internal string Ordinary => ordinary;
    internal string NewRoot()
    {
        var root = Path.Combine(directory, "records-" + Program.Id());
        Probe.CreateRoot(root);
        return root;
    }
    internal async Task<Actor> NewActorAsync(CancellationToken token, bool failBeforePin = false)
    {
        var actor = new Actor(directory);
        Actors.Add(actor);
        actor.Start(failBeforePin);
        await actor.LoadedAsync(token);
        return actor;
    }
    internal async Task<(Actor Actor, JsonElement Result)> ReserveAsync(string root, JournalScope scope, string executionId, CancellationToken token)
    {
        var actor = await NewActorAsync(token);
        var result = await actor.CallAsync("reserve", new { root, scope, executionId }, token);
        return (actor, result);
    }
    internal static void Created(JsonElement value) => Program.Require(Program.Text(value, "status") == "Created" && value.GetProperty("ownerPresent").GetBoolean(), "Reserve did not create the sole original writer.");
    internal static async Task<JsonElement> PublishAsync(Actor actor, string recordId, string recordJson, CancellationToken token, string? pause = null, string? fault = null) => await actor.CallAsync("publish", new { recordId, recordJson, pause, fault = fault ?? "None" }, token);
    internal async Task<(string Root, JournalScope Scope, string ExecutionId, string RecordId, JsonElement Record)> SeedAsync(CancellationToken token)
    {
        var root = NewRoot(); var scope = Program.Scope(); var executionId = Program.Id(); var recordId = Program.Id();
        var seed = await ReserveAsync(root, scope, executionId, token);
        Created(seed.Result);
        var publication = await PublishAsync(seed.Actor, recordId, "{\"a\":1,\"nested\":{\"label\":\"seed\"}}", token);
        Program.Require(Program.Text(publication, "status") == "Created", "Seed publication was not Created.");
        await seed.Actor.ExitAsync(token);
        return (root, scope, executionId, recordId, publication.GetProperty("snapshot").GetProperty("record").Clone());
    }
}

internal static class Harness
{
    internal static async Task<int> RunAsync(string ordinary, string directory, int executionMs, int cleanupMs, string control)
    {
        if (executionMs <= 0 || cleanupMs <= 0 || !Path.IsPathFullyQualified(ordinary) || !File.Exists(ordinary) || !Path.IsPathFullyQualified(directory) || !Directory.Exists(directory)) throw new ArgumentException("Fixed harness inputs are invalid.");
        Program.Require(control is "none" or "host-before-ready", "Unknown private host control.");
        if (control == "host-before-ready")
        {
            using var bootstrap = JsonDocument.Parse(await Console.In.ReadLineAsync() ?? throw new EndOfStreamException("Private bootstrap controller closed."));
            Program.Require(bootstrap.RootElement.GetProperty("bootstrap").GetBoolean(), "Private bootstrap barrier is invalid.");
            Program.Write(new { kind = "host-bootstrap-failure", error = Program.Error(new InvalidDataException("private_host_before_ready")), actorLaunches = 0 });
            return 1;
        }
        using var self = ProcessPin.Current();
        Program.Write(new { kind = "harness-ready", identity = self.Identity, selfHandleNonInherited = self.NonInherited, sameSid = self.SameSid, actorLaunches = 0 });
        // No Actor is constructed or started until Outer verifies assignment
        // and forwards this first command. The harness owns no Job handle.
        if (await Console.In.ReadLineAsync() is { } line)
        {
            using var parsed = JsonDocument.Parse(line);
            var scenario = Program.Text(parsed.RootElement, "scenario");
            var run = new RunContext(directory, ordinary);
            object? setupFailure = null; object? failure = null;
            object? setup = null; object cleanup;
            var cleanupFailures = new List<object>();
            using var deadline = new CancellationTokenSource(executionMs);
            try
            {
                var root = run.NewRoot();
                using var pinned = Probe.Open(root, directory: true);
                setup = new { root = Probe.FileEvidence(pinned), volume = Probe.Volume(root, pinned), inputEncoding = Program.EncodingEvidence(Console.InputEncoding), outputEncoding = Program.EncodingEvidence(Console.OutputEncoding) };
                Probe.RequireProtected(pinned, directory: true);
            }
            catch (Exception error) { setupFailure = Program.Error(error); }
            try { if (setupFailure is null) await ScenarioAsync(run, scenario, deadline.Token); }
            catch (Exception error) { failure = Program.Error(error); }
            finally
            {
                var cleanupDeadlineTick = checked(Environment.TickCount64 + cleanupMs);
                Program.Write(new { kind = "host-cleanup-start", deadlineTick = cleanupDeadlineTick });
                using var grace = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupDeadlineTick - Environment.TickCount64)));
                foreach (var actor in run.Actors)
                {
                    try { actor.TerminateOriginal(); } catch (Exception error) { cleanupFailures.Add(new { stage = "actor-original-terminate", error = Program.Error(error) }); }
                }
                foreach (var actor in run.Actors)
                {
                    try
                    {
                        await actor.CleanupAsync(grace.Token);
                        Program.Require(actor.Joined && actor.StreamsJoined, "Original Actor join or actual stream EOF is unproven.");
                    }
                    catch (Exception error) { cleanupFailures.Add(new { stage = "actor-original-join-and-streams", error = Program.Error(error) }); }
                }
                var snapshots = run.Actors.Select(actor => actor.Snapshot()).ToArray();
                cleanup = new { failures = cleanupFailures, liveOwnedProcesses = run.Actors.Where(actor => !actor.Joined).Select(actor => actor.Snapshot()).ToArray(), allObservedJoined = run.Actors.All(actor => actor.Joined && actor.StreamsJoined), originalRegistry = true, processes = snapshots, deadlineTick = cleanupDeadlineTick };
            }
            Program.Write(new { kind = "receipt", value = new { scenario, setupFailure, failure, setup, values = run.Values, reservation = run.ReservationResult, actors = run.Actors.Select(actor => actor.Snapshot()).ToArray(), cleanup, conditionalUnexecuted = new[] { "independent-wrong-SID", "remote-filesystem", "non-NTFS-volume", "other-volume" } } });
            foreach (var actor in run.Actors) actor.Dispose();
        }
        return 0;
    }
    private static Task ScenarioAsync(RunContext run, string scenario, CancellationToken token) => scenario switch
    {
        "positive" => PositiveAsync(run, token), "J1" => J1Async(run, token), "J2" => J2Async(run, token), "J3" => J3Async(run, token), "J4" => J4Async(run, token), "J5" => J5Async(run, token), "J6" => J6Async(run, token), "J7" => J7Async(run, token), "J8" => J8Async(run, token),
        "private-guarded" => PrivateGuardedAsync(run, token), "private-actor-retain" => PrivateActorRetentionAsync(run, token), "private-held" => PrivateHeldAsync(run, token), _ => throw new InvalidDataException("Unknown private journal scenario.")
    };

    private static async Task PrivateGuardedAsync(RunContext run, CancellationToken token)
    {
        var actor = await run.NewActorAsync(token);
        run.Values["privateGuarded"] = await actor.CallAsync("echo", new { text = Program.Unicode }, token);
        await actor.ExitAsync(token);
    }
    private static async Task PrivateActorRetentionAsync(RunContext run, CancellationToken token) { await run.NewActorAsync(token, failBeforePin: true); }
    private static async Task PrivateHeldAsync(RunContext run, CancellationToken token)
    {
        var actor = await run.NewActorAsync(token);
        Program.Write(new { kind = "host-held", phase = "registered-actor-loaded", registered = run.Actors.Contains(actor), actor = actor.Snapshot() });
        // This real barrier has no continuation. Explicit outer close kills
        // the original host while this registered, loaded Actor is still live.
        var barrier = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await barrier.Task.WaitAsync(token);
    }

    private static async Task PositiveAsync(RunContext run, CancellationToken token)
    {
        var root = run.NewRoot();
        using var directory = Probe.OpenStrictRoot(root);
        var temporary = Path.Combine(root, "oracle-" + Program.Id() + ".tmp");
        var leaf = "oracle-" + Program.Id() + ".json";
        var bytes = Program.Utf8.GetBytes(Program.Unicode);
        using var file = Probe.Create(temporary);
        var beforeIdentity = Probe.Identity(file);
        var collision = Probe.TryCreate(temporary);
        Program.Require(!collision.Success, "CREATE_NEW overwrote an existing object.");
        Probe.Write(file, bytes);
        Probe.Check(Probe.FlushFileBuffers(file), "oracle_flush");
        var wrongRoot = run.NewRoot();
        using var wrongDirectory = Probe.OpenStrictRoot(wrongRoot);
        var wrongBefore = Probe.Tree(root);
        var wrongRootBefore = Probe.Tree(wrongRoot);
        object? wrongRootFailure = null;
        try { Probe.Rename(file, wrongDirectory, leaf); }
        catch (InvalidDataException error) when (error.Data["fixtureProbeStage"] as string == "independent_source_parent_binding") { wrongRootFailure = Program.Error(error); }
        Program.Require(wrongRootFailure is not null, "Wrong supplied root was not rejected before rename.");
        var wrongAfter = Probe.Tree(root);
        var wrongRootAfter = Probe.Tree(wrongRoot);
        Program.Require(JsonElement.DeepEquals(Program.Element(wrongBefore), Program.Element(wrongAfter)) && JsonElement.DeepEquals(Program.Element(wrongRootBefore), Program.Element(wrongRootAfter)), "Wrong supplied root changed filesystem names or evidence.");
        var rename = Probe.Rename(file, directory, leaf);
        var final = Path.Combine(root, leaf);
        using var reopened = Probe.Open(final);
        var afterIdentity = Probe.Identity(reopened);
        var observed = Probe.Read(reopened);
        Probe.RequireProtected(reopened, directory: false);
        var collisionPath = Path.Combine(root, "oracle-" + Program.Id() + ".tmp");
        using var collisionSource = Probe.Create(collisionPath);
        Probe.Write(collisionSource, Program.Utf8.GetBytes("occupied-target-source"));
        Probe.Check(Probe.FlushFileBuffers(collisionSource), "oracle_collision_flush");
        var collisionTargetBefore = Probe.PathEvidence(final);
        var collisionSourceBefore = Probe.PathEvidence(collisionPath);
        object? renameCollision = null;
        try { Probe.Rename(collisionSource, directory, leaf); }
        catch (Win32Exception error) { renameCollision = Program.Error(error); }
        Program.Require(renameCollision is not null, "Independent rename replaced an occupied target.");
        var collisionTargetAfter = Probe.PathEvidence(final);
        var collisionSourceAfter = Probe.PathEvidence(collisionPath);
        Program.Require(JsonElement.DeepEquals(Program.Element(collisionTargetBefore), Program.Element(collisionTargetAfter)) && JsonElement.DeepEquals(Program.Element(collisionSourceBefore), Program.Element(collisionSourceAfter)), "Occupied-target rename changed either original object.");
        var rootDeleteIntent = Probe.TryOpenDelete(root);
        Program.Require(!rootDeleteIntent.Success, "Independent strict root allowed a DELETE-intent open.");
        var actor = await run.NewActorAsync(token);
        var actorReady = await actor.LoadedAsync(token);
        var echo = await actor.CallAsync("echo", new { text = Program.Unicode }, token);
        await actor.ExitAsync(token);
        var context = new AssemblyLoadContext("ordinary-journal-surface-" + Program.Id(), isCollectible: true);
        bool ordinaryHasJournalApi; string[] ordinaryTestOnlyTypes;
        try
        {
            var assembly = context.LoadFromAssemblyPath(run.Ordinary);
            var types = assembly.GetTypes();
            ordinaryHasJournalApi = types.Any(type => type.FullName == "Zeb.WindowsSupervisor.ProtectedJournal");
            ordinaryTestOnlyTypes = types.Where(type => type.Name is "JournalTestControl" or "JournalTestStage" or "JournalTestFault").Select(type => type.Name).Order().ToArray();
        }
        finally { context.Unload(); }
        var parentStreams = Program.Element(actor.Encodings ?? throw new InvalidDataException("Private actor encodings were not retained."));
        run.Values["positive"] = new { createNewCollisionError = collision.NativeError, writeSucceeded = true, flushSucceeded = true, renameSucceeded = true, rename, bytesEqual = bytes.SequenceEqual(observed), beforeIdentity, afterIdentity, wrongRoot = new { failure = wrongRootFailure, before = wrongBefore, after = wrongAfter, otherBefore = wrongRootBefore, otherAfter = wrongRootAfter }, renameCollision = new { failure = renameCollision, targetBefore = collisionTargetBefore, targetAfter = collisionTargetAfter, sourceBefore = collisionSourceBefore, sourceAfter = collisionSourceAfter, sourceTempRetained = File.Exists(collisionPath) }, rootDeleteIntent, file = Probe.FileEvidence(reopened), root = Probe.FileEvidence(directory), volume = Probe.Volume(root, directory), ordinaryHasJournalApi, ordinaryTestOnlyTypes, unicode = Program.Text(echo, "text"), unicodeBase64 = Program.Text(echo, "base64"), encodings = new { childInput = actorReady.GetProperty("inputEncoding"), childOutput = actorReady.GetProperty("outputEncoding"), childError = actorReady.GetProperty("errorEncoding"), privateInput = parentStreams.GetProperty("input"), privateOutput = parentStreams.GetProperty("output"), privateError = parentStreams.GetProperty("error") }, childStderr = actor.Stderr.Select(text => JsonSerializer.Deserialize<string>(text, Program.Json)).ToArray() };
    }

    private static async Task J1Async(RunContext run, CancellationToken token)
    {
        var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id(); var recordId = Program.Id();
        var reserved = await run.ReserveAsync(root, scope, executionId, token);
        run.ReservationResult = reserved.Result;
        // Preserve a genuine behavioral RED on the frozen no-function scaffold.
        // No setup failure/timeout is substituted for missing Created.
        if (Program.Text(reserved.Result, "status") != "Created") return;
        RunContext.Created(reserved.Result);
        var recordJson = JsonSerializer.Serialize(new { label = Program.Unicode, nested = new { material = "原木", proportions = new[] { 1, 2, 3 } } }, Program.Json);
        var publication = await RunContext.PublishAsync(reserved.Actor, recordId, recordJson, token);
        var reservationRename = await reserved.Actor.StageAsync("ReservationRenamed", token);
        var recordRename = await reserved.Actor.StageAsync("RecordRenamed", token);
        using var rootPin = Probe.Open(root, directory: true);
        using var marker = Probe.Open(Program.Marker(root, scope));
        using var reservation = Probe.Open(Program.Reservation(root, scope));
        using var record = Probe.Open(Program.Record(root, scope, recordId));
        Probe.RequireProtected(rootPin, true); Probe.RequireProtected(marker, false); Probe.RequireProtected(reservation, false); Probe.RequireProtected(record, false);
        Probe.Envelope(reservation, rootPin, marker, scope, executionId, null);
        Probe.Envelope(record, rootPin, marker, scope, executionId, recordId);
        using (var actualReservation = JsonDocument.Parse(Program.Utf8.GetString(Probe.Read(reservation))))
        using (var actualRecord = JsonDocument.Parse(Program.Utf8.GetString(Probe.Read(record))))
            Program.Require(JsonElement.DeepEquals(reserved.Result.GetProperty("snapshot"), actualReservation.RootElement) && JsonElement.DeepEquals(publication.GetProperty("snapshot"), actualRecord.RootElement), "API snapshots differ from independently read actual envelope bytes.");
        var rootEvidence = Probe.FileEvidence(rootPin); var markerEvidence = Probe.FileEvidence(marker); var reservationEvidence = Probe.FileEvidence(reservation); var recordEvidence = Probe.FileEvidence(record);
        await reserved.Actor.ExitAsync(token);
        var inspector = await run.NewActorAsync(token);
        var reopened = await inspector.CallAsync("inspect", new { root, scope }, token);
        var read = await inspector.CallAsync("read", new { root, scope, executionId, recordId }, token);
        run.Values["J1"] = new { root = rootEvidence, marker = markerEvidence, reservationFile = reservationEvidence, recordFile = recordEvidence, reservationRenameIdentity = reservationRename.GetProperty("handles").GetProperty("originalIdentity"), recordRenameIdentity = recordRename.GetProperty("handles").GetProperty("originalIdentity"), publication, reopened, read };
    }

    private static async Task J2Async(RunContext run, CancellationToken token)
    {
        var root = run.NewRoot(); var scope = Program.Scope(); var firstId = Program.Id(); var secondId = Program.Id();
        var first = await run.NewActorAsync(token); var second = await run.NewActorAsync(token);
        // Both independently launched actors are ready before either command.
        // The winner is held after verified publication; no timed race guess.
        var firstCall = first.CallAsync("reserve", new { root, scope, executionId = firstId, pause = "ReservationVerified" }, token);
        var secondCall = second.CallAsync("reserve", new { root, scope, executionId = secondId, pause = "ReservationVerified" }, token);
        using var observations = CancellationTokenSource.CreateLinkedTokenSource(token);
        var firstStage = first.StageAsync("ReservationVerified", observations.Token);
        var secondStage = second.StageAsync("ReservationVerified", observations.Token);
        var winnerStage = await Task.WhenAny(firstStage, secondStage).WaitAsync(token);
        await winnerStage;
        var winner = winnerStage == firstStage ? first : second;
        var loserCall = winner == first ? secondCall : firstCall;
        var loser = await loserCall;
        Program.Require(Program.Text(loser, "status") != "Created" && !loser.GetProperty("ownerPresent").GetBoolean(), "Concurrent duplicate obtained a writer.");
        await winner.ReleaseAsync(token);
        var racers = await Task.WhenAll(firstCall, secondCall);
        observations.Cancel();
        try { await Task.WhenAll(firstStage, secondStage); } catch (OperationCanceledException) { }
        var winnerExecutionId = winner == first ? firstId : secondId;
        await first.ExitAsync(token); await second.ExitAsync(token);
        var duplicateActor = await run.NewActorAsync(token);
        var duplicateExecutionId = Program.Id();
        var duplicate = await duplicateActor.CallAsync("reserve", new { root, scope, executionId = duplicateExecutionId }, token);
        var mismatches = new List<object>();
        var changes = new (string Name, JournalScope Scope)[]
        {
            ("jobId", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { JobId = "other-job" } } }),
            ("attemptNo", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { AttemptNo = 2 } } }),
            ("ownerInstanceId", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { OwnerInstanceId = "other-owner" } } }),
            ("fence", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { Fence = 8 } } }),
            ("executionPolicyFingerprint", scope with { ExecutionPolicyFingerprint = new string('b', 64) })
        };
        foreach (var change in changes)
            mismatches.Add(new { name = change.Name, result = await duplicateActor.CallAsync("inspect", new { root, scope = change.Scope }, token) });
        var independentScope = scope with { Target = scope.Target with { LaunchTicket = "another-ticket-" + Program.Id() } };
        var independent = await duplicateActor.CallAsync("reserve", new { root, scope = independentScope, executionId = Program.Id() }, token);
        RunContext.Created(independent);
        await duplicateActor.CallAsync("dispose", null, token);
        var invalidArguments = new List<object>();
        var invalids = new (string Name, JournalScope Scope, string ExecutionId)[]
        {
            ("empty-job", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { JobId = "" } } }, Program.Id()),
            ("leading-FEFF", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { JobId = "\uFEFFjob" } } }, Program.Id()),
            ("trailing-FEFF", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { OwnerInstanceId = "owner\uFEFF" } } }, Program.Id()),
            ("leading-space", scope with { Target = scope.Target with { LaunchTicket = " ticket" } }, Program.Id()),
            ("control-nul", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { JobId = "a\0b" } } }, Program.Id()),
            ("control-del", scope with { Target = scope.Target with { LaunchTicket = "a\u007fb" } }, Program.Id()),
            ("attempt-zero", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { AttemptNo = 0 } } }, Program.Id()),
            ("attempt-unsafe", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { AttemptNo = 9007199254740992 } } }, Program.Id()),
            ("fence-zero", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { Fence = 0 } } }, Program.Id()),
            ("fence-unsafe", scope with { Target = scope.Target with { Identity = scope.Target.Identity with { Fence = 9007199254740992 } } }, Program.Id()),
            ("fingerprint-upper", scope with { ExecutionPolicyFingerprint = new string('A', 64) }, Program.Id()),
            ("fingerprint-short", scope with { ExecutionPolicyFingerprint = "a" }, Program.Id()),
            ("execution-id-upper", scope, new string('A', 32)),
            ("execution-id-path", scope, "../record")
        };
        foreach (var invalid in invalids)
        {
            var before = Probe.Tree(root);
            var observed = await duplicateActor.CallAsync("reserve", new { root, scope = invalid.Scope, executionId = invalid.ExecutionId }, token);
            Program.Require(JsonElement.DeepEquals(Program.Element(before), Program.Element(Probe.Tree(root))), "Invalid call changed filesystem evidence.");
            invalidArguments.Add(new { name = invalid.Name, errorType = Program.Text(observed, "errorType") });
        }
        var nonWhitespaceScope = new JournalScope(new(new("\u0085job\u0085", 9007199254740991, "\u0085owner\u0085", 9007199254740991), "\u0085ticket-" + Program.Id() + "\u0085"), scope.ExecutionPolicyFingerprint);
        var jsNonWhitespace = await duplicateActor.CallAsync("reserve", new { root, scope = nonWhitespaceScope, executionId = Program.Id() }, token);
        RunContext.Created(jsNonWhitespace);
        foreach (var invalid in new[]
        {
            (Name: "record-id-path", RecordId: "../record", Json: "{}"),
            (Name: "record-id-upper", RecordId: new string('A', 32), Json: "{}"),
            (Name: "record-array", RecordId: Program.Id(), Json: "[]"),
            (Name: "record-null", RecordId: Program.Id(), Json: "null"),
            (Name: "record-duplicate", RecordId: Program.Id(), Json: "{\"deep\":{\"x\":1,\"x\":2}}")
        })
        {
            var before = Probe.Tree(root);
            var observed = await RunContext.PublishAsync(duplicateActor, invalid.RecordId, invalid.Json, token);
            Program.Require(JsonElement.DeepEquals(Program.Element(before), Program.Element(Probe.Tree(root))), "Invalid publication changed filesystem evidence.");
            invalidArguments.Add(new { name = invalid.Name, errorType = Program.Text(observed, "errorType") });
        }
        await duplicateActor.CallAsync("dispose", null, token);
        var inconsistentHistory = new List<object>();
        foreach (var name in new[] { "orphan-final", "orphan-temp" })
        {
            var historyRoot = run.NewRoot(); var historyScope = Program.Scope();
            var orphan = name == "orphan-final" ? Program.Reservation(historyRoot, historyScope) : Path.Combine(historyRoot, Program.Key(historyScope) + ".reservation." + Program.Id() + ".tmp");
            using (var file = Probe.Create(orphan)) { Probe.Write(file, Program.Utf8.GetBytes("incomplete-history")); Probe.Check(Probe.FlushFileBuffers(file), "orphan_history_flush"); }
            var beforeOriginal = Probe.PathEvidence(orphan);
            var observed = await duplicateActor.CallAsync("reserve", new { root = historyRoot, scope = historyScope, executionId = Program.Id() }, token);
            inconsistentHistory.Add(new { name, result = observed, beforeOriginal, afterOriginal = Probe.PathEvidence(orphan), markerRetained = File.Exists(Program.Marker(historyRoot, historyScope)), fileCount = Directory.EnumerateFiles(historyRoot).Count() });
        }
        var missingRoot = root + "-absent";
        var missingRootResult = await duplicateActor.CallAsync("reserve", new { root = missingRoot, scope, executionId = Program.Id() }, token);
        run.Values["J2"] = new { racers, winnerExecutionId, duplicateExecutionId, duplicate, scopeMismatches = mismatches, independentTicket = independent, invalidArguments, jsNonWhitespace, inconsistentHistory, missingRoot = new { result = missingRootResult, directoryCreated = Directory.Exists(missingRoot) } };
    }

    private static async Task J3Async(RunContext run, CancellationToken token)
    {
        var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id(); var recordId = Program.Id();
        var reserved = await run.ReserveAsync(root, scope, executionId, token); RunContext.Created(reserved.Result);
        var first = await RunContext.PublishAsync(reserved.Actor, recordId, "{\"a\":1,\"nested\":{\"b\":2,\"c\":3}}", token);
        var replay = await RunContext.PublishAsync(reserved.Actor, recordId, "{\"nested\":{\"c\":3,\"b\":2},\"a\":1}", token);
        var changed = await RunContext.PublishAsync(reserved.Actor, recordId, "{\"a\":2,\"nested\":{\"b\":2,\"c\":3}}", token);
        var collisionId = Program.Id();
        var priorFrameCount = reserved.Actor.Frames.Length;
        var collisionCall = RunContext.PublishAsync(reserved.Actor, collisionId, "{\"candidate\":true}", token, "RecordFlushed");
        await reserved.Actor.StageAsync("RecordFlushed", token, priorFrameCount);
        var targetPath = Program.Record(root, scope, collisionId);
        // This object is genuinely created only after normal temp flush. Its
        // own valid envelope binds its actual independently queried FileId.
        using (var target = Probe.Create(targetPath))
        {
            var envelope = JsonNode.Parse(first.GetProperty("snapshot").GetRawText())!.AsObject();
            envelope["recordId"] = collisionId;
            envelope["fileIdentity"] = JsonSerializer.SerializeToNode(Probe.Identity(target), Program.Json);
            envelope["record"] = JsonNode.Parse("{\"collision\":\"original\"}");
            Probe.Write(target, Program.Utf8.GetBytes(envelope.ToJsonString(Program.Json)));
            Probe.Check(Probe.FlushFileBuffers(target), "collision_target_flush");
        }
        var before = Probe.PathEvidence(targetPath);
        await reserved.Actor.ReleaseAsync(token);
        var collision = await collisionCall;
        var after = Probe.PathEvidence(targetPath);
        var retainedTemps = Probe.Tree(root).Where(item => Program.Text(Program.Element(item), "leaf").EndsWith(".tmp", StringComparison.Ordinal)).ToArray();
        run.Values["J3"] = new { first, replay, changed, collision, before, after, retainedTemps, pausedStage = "RecordFlushed" };
    }

    private static async Task J4Async(RunContext run, CancellationToken token)
    {
        var rows = new List<object>();
        string[] variants = ["invalid-utf8", "partial-json", "trailing-json", "duplicate-key", "nested-duplicate-key", "unknown-key", "wrong-version", "wrong-type", "wrong-scope", "root-identity", "marker-identity", "final-identity", "replaced-final", "replaced-marker", "replaced-root", "hardlink", "extra-ace", "reparse-root", "nonordinary-final"];
        foreach (var name in variants)
        {
            var seed = await run.SeedAsync(token);
            var root = seed.Root;
            var target = Program.Record(root, seed.Scope, seed.RecordId);
            var bytes = File.ReadAllBytes(target);
            var text = Program.Utf8.GetString(bytes);
            var node = JsonNode.Parse(text)!.AsObject();
            switch (name)
            {
                case "invalid-utf8": File.WriteAllBytes(target, [0xc3, 0x28]); break;
                case "partial-json": File.WriteAllBytes(target, Program.Utf8.GetBytes(text[..^1])); break;
                case "trailing-json": File.WriteAllBytes(target, Program.Utf8.GetBytes(text + "{}")); break;
                case "duplicate-key": File.WriteAllBytes(target, Program.Utf8.GetBytes("{\"v\":1," + text[1..])); break;
                case "nested-duplicate-key": node["record"] = null; File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json).Replace("\"record\":null", "\"record\":{\"deep\":{\"x\":1,\"x\":2}}", StringComparison.Ordinal))); break;
                case "unknown-key": node["unexpected"] = true; File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "wrong-version": node["v"] = 2; File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "wrong-type": node["v"] = "1"; File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "wrong-scope": node["scope"]!["target"]!["identity"]!["jobId"] = "different-job"; File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "root-identity": node["rootIdentity"]!["fileId"] = new string('0', 32); File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "marker-identity": node["reservationIdentity"]!["fileId"] = new string('0', 32); File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "final-identity": node["fileIdentity"]!["fileId"] = new string('0', 32); File.WriteAllBytes(target, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
                case "replaced-final":
                    File.Move(target, target + ".original");
                    using (var replacement = Probe.Create(target)) Probe.Write(replacement, bytes);
                    break;
                case "replaced-marker":
                    var marker = Program.Marker(root, seed.Scope); File.Move(marker, marker + ".original");
                    using (var replacement = Probe.Create(marker)) { }
                    break;
                case "replaced-root":
                    var moved = root + "-original"; Directory.Move(root, moved); Probe.CreateRoot(root);
                    foreach (var path in Directory.EnumerateFiles(moved)) File.Move(path, Path.Combine(root, Path.GetFileName(path)));
                    break;
                case "hardlink": Probe.Check(Probe.CreateHardLinkW(target + ".hardlink", target, IntPtr.Zero), "independent_hardlink"); break;
                case "extra-ace": Probe.AddExtraAce(target); break;
                case "reparse-root":
                    var alias = root + "-junction"; Directory.CreateDirectory(alias); Probe.SetJunction(alias, root); root = alias;
                    Program.Require((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0, "Independent junction did not become a reparse point.");
                    break;
                case "nonordinary-final": File.Move(target, target + ".original"); Directory.CreateDirectory(target); break;
            }
            var before = Probe.Tree(root);
            var inspector = await run.NewActorAsync(token);
            var observed = await inspector.CallAsync("read", new { root, scope = seed.Scope, executionId = seed.ExecutionId, recordId = seed.RecordId }, token);
            var after = Probe.Tree(root);
            await inspector.ExitAsync(token);
            rows.Add(new { name, result = observed, before, after, freshLeaf = true });
        }
        run.Values["J4"] = rows;
        var reservationRows = new List<object>();
        foreach (var name in new[] { "invalid-utf8", "partial-json", "trailing-json", "duplicate-key", "unknown-key", "wrong-version", "wrong-type", "wrong-scope", "root-identity", "marker-identity", "final-identity", "wrong-kind" })
        {
            var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id();
            var reserved = await run.ReserveAsync(root, scope, executionId, token); RunContext.Created(reserved.Result);
            await reserved.Actor.ExitAsync(token);
            var path = Program.Reservation(root, scope); var bytes = File.ReadAllBytes(path); var text = Program.Utf8.GetString(bytes); var node = JsonNode.Parse(text)!.AsObject();
            switch (name)
            {
                case "invalid-utf8": File.WriteAllBytes(path, [0xc3, 0x28]); break;
                case "partial-json": File.WriteAllBytes(path, Program.Utf8.GetBytes(text[..^1])); break;
                case "trailing-json": File.WriteAllBytes(path, Program.Utf8.GetBytes(text + "{}")); break;
                case "duplicate-key": File.WriteAllBytes(path, Program.Utf8.GetBytes("{\"v\":1," + text[1..])); break;
                default:
                    switch (name)
                    {
                        case "unknown-key": node["unexpected"] = true; break;
                        case "wrong-version": node["v"] = 2; break;
                        case "wrong-type": node["v"] = "1"; break;
                        case "wrong-scope": node["scope"]!["target"]!["identity"]!["jobId"] = "different-job"; break;
                        case "root-identity": node["rootIdentity"]!["fileId"] = new string('0', 32); break;
                        case "marker-identity": node["reservationIdentity"]!["fileId"] = new string('0', 32); break;
                        case "final-identity": node["fileIdentity"]!["fileId"] = new string('0', 32); break;
                        case "wrong-kind": node["kind"] = "record"; break;
                    }
                    File.WriteAllBytes(path, Program.Utf8.GetBytes(node.ToJsonString(Program.Json))); break;
            }
            var before = Probe.Tree(root);
            var inspector = await run.NewActorAsync(token);
            var observed = await inspector.CallAsync("inspect", new { root, scope }, token);
            var duplicate = await inspector.CallAsync("reserve", new { root, scope, executionId = Program.Id() }, token);
            var after = Probe.Tree(root);
            await inspector.ExitAsync(token);
            reservationRows.Add(new { name, result = observed, duplicate, before, after, freshLeaf = true });
        }
        run.Values["J4Reservation"] = reservationRows;
    }

    private static async Task J5Async(RunContext run, CancellationToken token)
    {
        var rows = new List<object>();
        foreach (var stage in new[] { "MarkerCreated", "ReservationWritten", "ReservationFlushed" })
        {
            var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id();
            var actor = await run.NewActorAsync(token);
            var held = actor.CallAsync("reserve", new { root, scope, executionId, pause = stage }, token);
            await actor.StageAsync(stage, token);
            var replyBeforeKill = actor.HasReply;
            await actor.KillAsync(token);
            try { await held; throw new InvalidDataException("Crash boundary unexpectedly returned a reply."); } catch (EndOfStreamException) { }
            var before = Probe.Tree(root);
            var inspector = await run.NewActorAsync(token);
            var inspected = await inspector.CallAsync("inspect", new { root, scope }, token);
            var duplicate = await inspector.CallAsync("reserve", new { root, scope, executionId = Program.Id() }, token);
            var after = Probe.Tree(root);
            rows.Add(new { stage, replyBeforeKill, originalProcessJoined = !actor.Pin.Alive, inspected, duplicate, before, after, markerRetained = File.Exists(Program.Marker(root, scope)), finalPresent = File.Exists(Program.Reservation(root, scope)), tempCount = Directory.EnumerateFiles(root, "*.tmp").Count() });
        }
        run.Values["J5"] = rows;
    }

    private static async Task J6Async(RunContext run, CancellationToken token)
    {
        var rows = new List<object>();
        foreach (var stage in new[] { "ReservationRenamed", "ReservationVerified", "RecordRenamed", "RecordVerified" })
        {
            var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id(); var recordId = Program.Id();
            var actor = await run.NewActorAsync(token);
            Task<JsonElement> held;
            var record = Program.Element(new { label = Program.Unicode });
            if (stage.StartsWith("Record", StringComparison.Ordinal))
            {
                RunContext.Created(await actor.CallAsync("reserve", new { root, scope, executionId }, token));
                held = RunContext.PublishAsync(actor, recordId, record.GetRawText(), token, stage);
            }
            else held = actor.CallAsync("reserve", new { root, scope, executionId, pause = stage }, token);
            await actor.StageAsync(stage, token);
            // A prior reserve reply exists for record variants; check the held
            // operation's own correlated reply, never any earlier ACK.
            var replyBeforeKill = held.IsCompleted;
            await actor.KillAsync(token);
            try { await held; throw new InvalidDataException("Crash boundary unexpectedly returned a reply."); } catch (EndOfStreamException) { }
            var before = Probe.Tree(root);
            var inspector = await run.NewActorAsync(token);
            var inspected = await inspector.CallAsync("inspect", new { root, scope }, token);
            var duplicate = await inspector.CallAsync("reserve", new { root, scope, executionId = Program.Id() }, token);
            object? read = stage.StartsWith("Record", StringComparison.Ordinal) ? await inspector.CallAsync("read", new { root, scope, executionId, recordId }, token) : null;
            var after = Probe.Tree(root);
            rows.Add(new { stage, executionId, record, replyBeforeKill, originalProcessJoined = !actor.Pin.Alive, inspected, duplicate, read, before, after });
        }
        run.Values["J6"] = rows;
    }

    private static async Task J7Async(RunContext run, CancellationToken token)
    {
        var rows = new List<object>();
        foreach (var slot in new[] { "reservation", "record" })
        foreach (var fault in new[] { "WriteReadOnly", "FlushReadOnly" })
        {
            var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id(); var recordId = Program.Id();
            var actor = await run.NewActorAsync(token);
            if (slot == "record") RunContext.Created(await actor.CallAsync("reserve", new { root, scope, executionId }, token));
            var oldFrameCount = actor.Frames.Length;
            var observed = slot == "reservation"
                ? await actor.CallAsync("reserve", new { root, scope, executionId, fault }, token)
                : await RunContext.PublishAsync(actor, recordId, "{\"fault\":true}", token, fault: fault);
            var expectedStage = fault == "WriteReadOnly" ? "BeforeWrite" : "BeforeFlush";
            var boundaries = actor.Frames.Skip(oldFrameCount).Where(frame => Program.Text(frame, "kind") == "stage" && Program.Text(frame, "stage") == expectedStage).ToArray();
            Program.Require(boundaries.Length == 1, "Fault did not reach exactly one actual normal I/O boundary.");
            var final = slot == "reservation" ? Program.Reservation(root, scope) : Program.Record(root, scope, recordId);
            object? uncertainReplay = null;
            if (slot == "record")
            {
                // An explicit call on the same original Owner is not recovery
                // permission. A retained failed temp cannot become retry input.
                var before = Probe.Tree(root);
                var replayFrameCursor = actor.Frames.Length;
                var replay = await RunContext.PublishAsync(actor, recordId, "{\"fault\":true}", token, fault: "None");
                var newStages = actor.Frames.Skip(replayFrameCursor).Where(frame => Program.Text(frame, "kind") == "stage").Select(frame => Program.Text(frame, "stage")).ToArray();
                uncertainReplay = new { result = replay, before, after = Probe.Tree(root), newStages };
            }
            rows.Add(new { name = slot + "-" + fault, result = observed, io = boundaries[0].GetProperty("handles"), finalPresent = File.Exists(final), tempCount = Directory.EnumerateFiles(root, "*.tmp").Count(), ioBoundaryCount = boundaries.Length, uncertainReplay });
        }
        run.Values["J7"] = rows;
    }

    private static async Task J8Async(RunContext run, CancellationToken token)
    {
        var root = run.NewRoot(); var scope = Program.Scope(); var executionId = Program.Id(); var recordId = Program.Id();
        var reserved = await run.ReserveAsync(root, scope, executionId, token); RunContext.Created(reserved.Result);
        await RunContext.PublishAsync(reserved.Actor, recordId, "{\"pin\":true}", token);
        var before = Probe.Tree(root);
        var attempts = new List<object>();
        foreach (var path in new[] { Program.Marker(root, scope), Program.Reservation(root, scope), Program.Record(root, scope, recordId) })
        {
            attempts.Add(new { leaf = Path.GetFileName(path), op = "write", success = Probe.TryOpenWrite(path).Success, nativeError = Probe.LastAttemptError });
            var deleted = Probe.DeleteFileW(path); var deleteError = deleted ? 0 : Marshal.GetLastWin32Error();
            attempts.Add(new { leaf = Path.GetFileName(path), op = "delete", success = deleted, nativeError = deleteError });
            var renamed = Probe.MoveFileExW(path, path + ".moved", 0); var renameError = renamed ? 0 : Marshal.GetLastWin32Error();
            attempts.Add(new { leaf = Path.GetFileName(path), op = "rename", success = renamed, nativeError = renameError });
        }
        var rootRenamed = Probe.MoveFileExW(root, root + ".moved", 0); var rootRenameError = rootRenamed ? 0 : Marshal.GetLastWin32Error();
        attempts.Add(new { leaf = "records-root", op = "rename", success = rootRenamed, nativeError = rootRenameError });
        var observer = await run.NewActorAsync(token);
        var liveInspections = new List<object>();
        // Repetition is read-only evidence, not a poll waiting for a state.
        foreach (var _ in new[] { "first", "second" })
            liveInspections.Add(new { inspect = await observer.CallAsync("inspect", new { root, scope }, token), read = await observer.CallAsync("read", new { root, scope, executionId, recordId }, token) });
        var after = Probe.Tree(root);
        var disposal = await reserved.Actor.CallAsync("dispose", null, token);
        var afterDispose = await observer.CallAsync("read", new { root, scope, executionId, recordId }, token);
        var disposedPublish = await RunContext.PublishAsync(reserved.Actor, Program.Id(), "{\"late\":true}", token);
        var emptyRoot = run.NewRoot(); var emptyScope = Program.Scope();
        var emptyBefore = Probe.Tree(emptyRoot);
        var emptyInspect = await observer.CallAsync("inspect", new { root = emptyRoot, scope = emptyScope }, token);
        var emptyRead = await observer.CallAsync("read", new { root = emptyRoot, scope = emptyScope, executionId = Program.Id(), recordId = Program.Id() }, token);
        run.Values["J8"] = new { attempts, liveInspections, before, after, afterDispose, disposedPublishError = Program.Text(disposedPublish, "errorType"), doubleDisposeSucceeded = disposal.GetProperty("doubleDisposeSucceeded").GetBoolean(), emptyReadOnly = new { before = emptyBefore, after = Probe.Tree(emptyRoot), inspect = emptyInspect, read = emptyRead } };
    }
}

// File/volume/ACL/Job probes deliberately have no production dependencies.
// File reads use a diagnostic compatible share only; production inspectors are
// separate actor calls, so this probe never widens their strict share contract.
internal static class Probe
{
    internal static string CurrentSid { get; } = ReadCurrentSid();
    private static string ReadCurrentSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User?.Value ?? throw new InvalidOperationException("Current token has no user SID.");
    }
    internal static int LastAttemptError { get; private set; }
    internal sealed record Attempt(bool Success, int NativeError);
    internal static void Check(bool success, string stage, object? evidence = null, int? capturedError = null)
    {
        if (success) return;
        var error = new Win32Exception(capturedError ?? Marshal.GetLastWin32Error(), stage);
        error.Data["fixtureProbeStage"] = stage;
        if (evidence is not null) error.Data["fixtureProbeEvidence"] = evidence;
        throw error;
    }
    internal static bool NonInherited(SafeHandle handle) { Check(GetHandleInformation(handle, out var flags), "query_handle_noninheritance"); return (flags & 1) == 0; }
    internal static bool Signaled(SafeHandle handle)
    {
        var wait = WaitForSingleObject(handle, 0);
        return wait switch { 0 => true, 258 => false, _ => throw new Win32Exception(Marshal.GetLastWin32Error(), "query_original_process_signal") };
    }
    internal static ulong CreationTime(SafeHandle process) { Check(GetProcessTimes(process, out var created, out _, out _, out _), "query_original_process_creation"); return unchecked((ulong)created); }
    internal static string ProcessSid(SafeHandle process)
    {
        Check(OpenProcessToken(process, 8, out var token), "open_original_process_token");
        using (token)
        {
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out var length);
            Program.Require(length > 0, "Token query returned no required size.");
            var buffer = Marshal.AllocHGlobal(checked((int)length));
            try { Check(GetTokenInformation(token, 1, buffer, length, out _), "query_original_process_sid"); return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    internal static bool InJob(SafeHandle process, SafeFileHandle job) { Check(IsProcessInJob(process, job, out var member), "query_guard_membership"); return member; }
    internal static void SetKillOnClose(SafeFileHandle job)
    {
        var limits = new JobExtendedLimits { Basic = new JobBasicLimits { LimitFlags = 0x00002000 } };
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<JobExtendedLimits>()), "guard_set_kill_on_close");
        Check(QueryInformationJobObject(job, 9, out JobExtendedLimits actual, (uint)Marshal.SizeOf<JobExtendedLimits>(), IntPtr.Zero), "guard_query_kill_on_close");
        Program.Require(actual.Basic.LimitFlags == 0x00002000, "Private Job kill-on-close setting differs.");
    }
    internal static uint JobActive(SafeFileHandle job)
    {
        Check(QueryInformationJobObject(job, 1, out JobAccounting accounting, (uint)Marshal.SizeOf<JobAccounting>(), IntPtr.Zero), "query_guard_active_processes");
        return accounting.ActiveProcesses;
    }
    internal static uint[] JobMembers(SafeFileHandle job, CancellationToken token)
    {
        Check(QueryInformationJobObject(job, 1, out JobAccounting accounting, (uint)Marshal.SizeOf<JobAccounting>(), IntPtr.Zero), "query_guard_accounting");
        var headerBytes = checked((int)Marshal.OffsetOf<JobProcessIdList>(nameof(JobProcessIdList.FirstProcessId)).ToInt64());
        var minimumBytes = Marshal.SizeOf<JobProcessIdList>();
        // JOBOBJECT_BASIC_PROCESS_ID_LIST declares ProcessIdList[1]. Even
        // active0 requires its first ULONG_PTR slot, not a header-only buffer.
        var capacity = Math.Max(1u, accounting.ActiveProcesses);
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var bytes = Math.Max(minimumBytes, checked(headerBytes + (int)capacity * IntPtr.Size));
            var buffer = Marshal.AllocHGlobal(bytes);
            try
            {
                Marshal.WriteInt32(buffer, 0, 0); Marshal.WriteInt32(buffer, 4, 0);
                if (!QueryInformationJobObject(job, 3, buffer, (uint)bytes, out var returned))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 234) throw new Win32Exception(error, "query_owned_guard_processes");
                    var assigned = checked((uint)Marshal.ReadInt32(buffer));
                    var required = returned > headerBytes ? (returned - (uint)headerBytes) / (uint)IntPtr.Size : 0;
                    var larger = Math.Max(assigned, required);
                    Program.Require(larger > capacity, "Guard query gave no larger real buffer size.");
                    capacity = Math.Max(1u, larger); continue;
                }
                var count = checked((uint)Marshal.ReadInt32(buffer, 4));
                Program.Require(count <= capacity, "Guard membership exceeds returned buffer.");
                return Enumerable.Range(0, (int)count).Select(index => checked((uint)Marshal.ReadIntPtr(buffer, headerBytes + index * IntPtr.Size).ToInt64())).ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    internal static async Task WaitAsync(WaitHandle wait, CancellationToken token)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = ThreadPool.RegisterWaitForSingleObject(wait, (_, timedOut) => { if (!timedOut) completion.TrySetResult(); }, null, Timeout.Infinite, true);
        using var cancellation = token.Register(() => completion.TrySetCanceled(token));
        try { await completion.Task; } finally { registration.Unregister(null); }
    }

    internal static void CreateRoot(string path)
    {
        var security = new DirectorySecurity();
        var sid = new SecurityIdentifier(CurrentSid);
        security.SetOwner(sid);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(sid, (FileSystemRights)0x001f01ff, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).Create(security);
        using var pinned = Open(path, directory: true);
        RequireProtected(pinned, directory: true);
    }
    internal static SafeFileHandle Open(string path, bool directory = false)
    {
        var handle = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error, "independent_evidence_open"); }
        Program.Require(NonInherited(handle), "Independent evidence handle is inherited.");
        return handle;
    }
    internal static SafeFileHandle OpenStrictRoot(string path)
    {
        var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        try
        {
            Check(!handle.IsInvalid, "independent_strict_root_open");
            RequireProtected(handle, directory: true);
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }
    internal static SafeFileHandle Create(string path)
    {
        var descriptorText = "O:" + CurrentSid + "D:P(A;;0x001f01ff;;;" + CurrentSid + ")";
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptorText, 1, out var descriptor, out _), "independent_explicit_file_security");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false };
            var handle = CreateFileW(path, 0xc0010000, 7, ref attributes, 1, 0x00200080, IntPtr.Zero);
            if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error, "independent_create_new"); }
            Program.Require(NonInherited(handle), "CREATE_NEW fixture handle is inherited.");
            return handle;
        }
        finally { LocalFree(descriptor); }
    }
    internal static Attempt TryCreate(string path)
    {
        using var handle = CreateFileW(path, 0xc0010000, 7, IntPtr.Zero, 1, 0x00200080, IntPtr.Zero);
        return new(!handle.IsInvalid, handle.IsInvalid ? Marshal.GetLastWin32Error() : 0);
    }
    internal static Attempt TryOpenWrite(string path)
    {
        using var handle = CreateFileW(path, 0x40000000, 7, IntPtr.Zero, 3, 0x00200080, IntPtr.Zero);
        LastAttemptError = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        return new(!handle.IsInvalid, LastAttemptError);
    }
    internal static Attempt TryOpenDelete(string path)
    {
        using var handle = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        return new(!handle.IsInvalid, handle.IsInvalid ? Marshal.GetLastWin32Error() : 0);
    }
    internal static Attempt TryWrite(SafeFileHandle handle)
    {
        var success = WriteFile(handle, [0x58], 1, out _, IntPtr.Zero);
        return new(success, success ? 0 : Marshal.GetLastWin32Error());
    }
    internal static Attempt TryFlush(SafeFileHandle handle)
    {
        var success = FlushFileBuffers(handle);
        return new(success, success ? 0 : Marshal.GetLastWin32Error());
    }
    internal static void Write(SafeFileHandle handle, byte[] bytes)
    {
        Check(WriteFile(handle, bytes, checked((uint)bytes.Length), out var written, IntPtr.Zero), "independent_write_all");
        Program.Require(written == bytes.Length, "Independent fixture write was partial.");
    }
    internal static byte[] Read(SafeFileHandle handle)
    {
        var info = Standard(handle);
        Program.Require(!info.Directory, "Cannot read directory as regular file evidence.");
        var bytes = new byte[checked((int)info.EndOfFile)];
        var offset = 0;
        while (offset < bytes.Length)
        {
            var count = RandomAccess.Read(handle, bytes.AsSpan(offset), offset);
            Program.Require(count > 0, "Independent file read ended before queried size.");
            offset += count;
        }
        return bytes;
    }
    private static string ActualGuidPath(SafeFileHandle handle)
    {
        var required = GetFinalPathNameByHandleW(handle, null, 0, 1);
        Check(required > 0, "independent_source_guid_path_size");
        var path = new StringBuilder(checked((int)required));
        var length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 1);
        Check(length > 0 && length < path.Capacity, "independent_source_guid_path");
        Program.Require(path.ToString().StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase), "Independent source is not on a normalized local GUID path.");
        return path.ToString();
    }
    internal static object Rename(SafeFileHandle file, SafeFileHandle root, string leaf)
    {
        Program.Require(!string.IsNullOrEmpty(leaf) && leaf is not "." and not ".." && leaf == Path.GetFileName(leaf) && leaf.IndexOfAny(['\\', '/', ':', '\0']) < 0, "Independent publication leaf is not simple.");
        RequireProtected(file, directory: false);
        RequireProtected(root, directory: true);
        var sourceIdentity = Identity(file);
        var sourceBytes = Read(file);
        var sourcePath = ActualGuidPath(file);
        var parentPath = Path.GetDirectoryName(sourcePath) ?? throw new InvalidDataException("Independent source has no actual parent.");
        using var parent = OpenStrictRoot(parentPath);
        var parentIdentity = Identity(parent);
        var rootIdentity = Identity(root);
        if (!JsonElement.DeepEquals(Program.Element(parentIdentity), Program.Element(rootIdentity)))
        {
            var error = new InvalidDataException("Independent source parent differs from supplied root.");
            error.Data["fixtureProbeStage"] = "independent_source_parent_binding";
            error.Data["fixtureProbeEvidence"] = new { renameAttempted = false, parentIdentity, rootIdentity };
            throw error;
        }
        var name = Encoding.Unicode.GetBytes(leaf);
        var headerBytes = Marshal.SizeOf<FileRenameInformation>();
        var rootOffset = checked((int)Marshal.OffsetOf<FileRenameInformation>(nameof(FileRenameInformation.RootDirectory)).ToInt64());
        var lengthOffset = checked((int)Marshal.OffsetOf<FileRenameInformation>(nameof(FileRenameInformation.FileNameLength)).ToInt64());
        var nameOffset = checked((int)Marshal.OffsetOf<FileRenameInformation>(nameof(FileRenameInformation.FileName)).ToInt64());
        var ioBytes = Marshal.SizeOf<IoStatusBlock>();
        var ioInformationOffset = checked((int)Marshal.OffsetOf<IoStatusBlock>(nameof(IoStatusBlock.Information)).ToInt64());
        Program.Require(IntPtr.Size == 8 && headerBytes == 24 && rootOffset == 8 && lengthOffset == 16 && nameOffset == 20 && ioBytes == 16 && ioInformationOffset == 8, "Independent Native rename/IO_STATUS_BLOCK x64 layout differs from declared ABI.");
        var size = checked(headerBytes + name.Length);
        Program.Require(size >= checked(nameOffset + name.Length + sizeof(char)), "Independent rename buffer has no WCHAR terminator space.");
        var buffer = Marshal.AllocHGlobal(size);
        var io = IntPtr.Zero;
        var fileHeld = false;
        var rootHeld = false;
        var completionKnown = true;
        try
        {
            io = Marshal.AllocHGlobal(ioBytes);
            Marshal.Copy(new byte[size], 0, buffer, size);
            Marshal.Copy(new byte[ioBytes], 0, io, ioBytes);
            file.DangerousAddRef(ref fileHeld);
            root.DangerousAddRef(ref rootHeld);
            var header = new FileRenameInformation { ReplaceIfExists = 0, RootDirectory = IntPtr.Zero, FileNameLength = checked((uint)name.Length), FileName = 0 };
            Marshal.StructureToPtr(header, buffer, fDeleteOld: false);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            var returnedStatus = NtSetInformationFile(file, io, buffer, checked((uint)size), 10);
            var completedStatus = returnedStatus;
            if (returnedStatus == 0x00000103)
            {
                completionKnown = false;
                // Retain both unmanaged buffers through actual completion.
                // The independent outer still owns the execution60000 limit.
                Check(WaitForSingleObject(file, uint.MaxValue) == 0, "independent_rename_pending_wait");
                completedStatus = Marshal.ReadInt32(io);
                Program.Require(completedStatus != 0x00000103, "Independent Native rename completion remained pending.");
                completionKnown = true;
            }
            var renameError = completedStatus == 0 ? 0 : unchecked((int)RtlNtStatusToDosError(completedStatus));
            // A non-pending return is authoritative even if the I/O block
            // remained zero, as observed on a genuine occupied-target failure.
            var layout = new { pointerBytes = IntPtr.Size, informationClass = 10, headerBytes, bufferBytes = size, replaceIfExists = Marshal.ReadByte(buffer, 0), rootDirectoryOffset = rootOffset, rootDirectoryNull = Marshal.ReadIntPtr(buffer, rootOffset) == IntPtr.Zero, rootHandleNonInherited = NonInherited(root), fileNameLengthOffset = lengthOffset, actualFileNameBytes = Marshal.ReadInt32(buffer, lengthOffset), fileNameOffset = nameOffset, fileNameBytes = name.Length, nulTerminatorPresent = Marshal.ReadInt16(buffer, nameOffset + name.Length) == 0, leafIsRelative = !Path.IsPathRooted(leaf), sourceParentBound = true, parentIdentity, rootIdentity, ioBytes, ioInformationOffset, returnedNtStatus = unchecked((uint)returnedStatus).ToString("x8", CultureInfo.InvariantCulture), ntStatus = unchecked((uint)completedStatus).ToString("x8", CultureInfo.InvariantCulture), ioStatus = unchecked((uint)Marshal.ReadInt32(io)).ToString("x8", CultureInfo.InvariantCulture) };
            Check(completedStatus == 0, "independent_no_replace_rename", layout, renameError);
            var actualFinal = ActualGuidPath(file);
            Program.Require(Path.GetFileName(actualFinal) == leaf, "Independent renamed source has a different final name.");
            using var finalParent = OpenStrictRoot(Path.GetDirectoryName(actualFinal) ?? throw new InvalidDataException("Independent final has no actual parent."));
            Program.Require(JsonElement.DeepEquals(Program.Element(Identity(finalParent)), Program.Element(rootIdentity)), "Independent renamed source parent differs from supplied root.");
            using var reopened = Open(Path.Combine(parentPath, leaf));
            RequireProtected(reopened, directory: false);
            Program.Require(JsonElement.DeepEquals(Program.Element(Identity(reopened)), Program.Element(sourceIdentity)) && Read(reopened).SequenceEqual(sourceBytes), "Independent final differs from retained source FileId or bytes.");
            return new { layout, finalNameMatches = true, finalParentBound = true, finalSameObject = true, finalBytesEqual = true };
        }
        finally
        {
            // Unknown pending I/O must retain its buffers/handle references
            // until this private host exits; freeing them would be unsafe.
            if (completionKnown) { if (rootHeld) root.DangerousRelease(); if (fileHeld) file.DangerousRelease(); if (io != IntPtr.Zero) Marshal.FreeHGlobal(io); Marshal.FreeHGlobal(buffer); }
        }
    }
    internal static object Identity(SafeFileHandle handle)
    {
        var buffer = Marshal.AllocHGlobal(24);
        try
        {
            Check(GetFileInformationByHandleEx(handle, 18, buffer, 24), "independent_file_id");
            var id = new byte[16]; Marshal.Copy(IntPtr.Add(buffer, 8), id, 0, 16);
            return new { volumeSerial = unchecked((ulong)Marshal.ReadInt64(buffer)).ToString(CultureInfo.InvariantCulture), fileId = Convert.ToHexStringLower(id) };
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    private static FileStandard Standard(SafeFileHandle handle)
    {
        Check(GetFileInformationByHandleEx(handle, 1, out FileStandard information, (uint)Marshal.SizeOf<FileStandard>()), "independent_file_standard");
        return information;
    }
    internal static object FileEvidence(SafeFileHandle handle)
    {
        var standard = Standard(handle);
        Check(GetFileInformationByHandleEx(handle, 0, out FileBasic basic, (uint)Marshal.SizeOf<FileBasic>()), "independent_file_basic");
        return new { identity = Identity(handle), security = Security(handle), nonInherited = NonInherited(handle), links = standard.Links, directory = standard.Directory, deletePending = standard.DeletePending, reparse = (basic.Attributes & 0x400) != 0, length = standard.EndOfFile, lastWriteTime = basic.LastWriteTime.ToString(CultureInfo.InvariantCulture) };
    }
    internal static object Security(SafeFileHandle handle)
    {
        var error = GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out var descriptor);
        if (error != 0) throw new Win32Exception((int)error, "independent_file_security");
        try
        {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0); var acl = security.DiscretionaryAcl;
            object[] aces = acl is null ? Array.Empty<object>() : acl.Cast<GenericAce>().Select(ace => new { type = ace.AceType.ToString(), flags = (int)ace.AceFlags, accessMask = ace is KnownAce known ? known.AccessMask : 0, sidMatchesCurrent = ace is KnownAce named && named.SecurityIdentifier.Value == CurrentSid }).Cast<object>().ToArray();
            return new { ownerMatchesCurrentSid = security.Owner?.Value == CurrentSid, daclPresent = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent), protectedDacl = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected), aceCount = acl?.Count ?? 0, aces };
        }
        finally { LocalFree(descriptor); }
    }
    internal static void RequireProtected(SafeFileHandle handle, bool directory)
    {
        var evidence = Program.Element(FileEvidence(handle)); var acl = evidence.GetProperty("security");
        Program.Require(evidence.GetProperty("nonInherited").GetBoolean() && !evidence.GetProperty("reparse").GetBoolean() && !evidence.GetProperty("deletePending").GetBoolean() && evidence.GetProperty("directory").GetBoolean() == directory, "Independent ordinary/noninherit check failed.");
        if (!directory) Program.Require(evidence.GetProperty("links").GetUInt32() == 1, "Independent file is not single-link.");
        Program.Require(acl.GetProperty("ownerMatchesCurrentSid").GetBoolean() && acl.GetProperty("daclPresent").GetBoolean() && acl.GetProperty("protectedDacl").GetBoolean() && acl.GetProperty("aceCount").GetInt32() == 1, "Independent protected owner/DACL check failed.");
        var ace = acl.GetProperty("aces")[0];
        Program.Require(Program.Text(ace, "type") == "AccessAllowed" && ace.GetProperty("flags").GetInt32() == 0 && ace.GetProperty("accessMask").GetInt32() == 0x001f01ff && ace.GetProperty("sidMatchesCurrent").GetBoolean(), "Independent exact file ACE check failed.");
    }
    internal static object Volume(string root, SafeFileHandle handle)
    {
        var mount = new StringBuilder(32768); Check(GetVolumePathNameW(root, mount, (uint)mount.Capacity), "independent_volume_mount");
        var guid = new StringBuilder(32768); Check(GetVolumeNameForVolumeMountPointW(mount.ToString(), guid, (uint)guid.Capacity), "independent_guid_volume_mapping");
        var volumeName = new StringBuilder(32768); var filesystem = new StringBuilder(32768);
        Check(GetVolumeInformationByHandleW(handle, volumeName, (uint)volumeName.Capacity, out _, out _, out var flags, filesystem, (uint)filesystem.Capacity), "independent_volume_information");
        var driveType = GetDriveTypeW(mount.ToString());
        var actual = new StringBuilder(32768); var length = GetFinalPathNameByHandleW(handle, actual, (uint)actual.Capacity, 1);
        Check(length > 0 && length < actual.Capacity, "independent_actual_guid_path");
        var mapped = guid.ToString().StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) && actual.ToString().StartsWith(guid.ToString(), StringComparison.OrdinalIgnoreCase);
        Program.Require(filesystem.ToString() == "NTFS" && driveType == 3 && (flags & 8) != 0 && mapped, "Mandatory independent local fixed NTFS environment is unavailable.");
        return new { filesystem = filesystem.ToString(), driveType, persistentAcls = (flags & 8) != 0, guidMapped = mapped };
    }
    internal static object PathEvidence(string path)
    {
        using var handle = Open(path, (File.GetAttributes(path) & FileAttributes.Directory) != 0);
        var information = Standard(handle);
        return new { file = FileEvidence(handle), bytesBase64 = information.Directory ? null : Convert.ToBase64String(Read(handle)) };
    }
    internal static object[] Tree(string root) => Directory.EnumerateFileSystemEntries(root).OrderBy(path => Path.GetFileName(path), StringComparer.Ordinal).Select(path => (object)new { leaf = Path.GetFileName(path), evidence = PathEvidence(path) }).ToArray();
    internal static void Envelope(SafeFileHandle file, SafeFileHandle root, SafeFileHandle marker, JournalScope scope, string executionId, string? recordId)
    {
        var bytes = Read(file); var text = Program.Utf8.GetString(bytes);
        using var document = JsonDocument.Parse(text); var envelope = document.RootElement;
        string[] keys = ["v", "kind", "scope", "executionId", "recordId", "rootIdentity", "reservationIdentity", "fileIdentity", "record"];
        Program.Require(envelope.ValueKind == JsonValueKind.Object && envelope.EnumerateObject().Select(item => item.Name).Order(StringComparer.Ordinal).SequenceEqual(keys.Order(StringComparer.Ordinal)), "Independent envelope fixed fields differ.");
        Program.Require(envelope.GetProperty("v").GetInt32() == 1 && Program.Text(envelope, "kind") == (recordId is null ? "reservation" : "record") && Program.Text(envelope, "executionId") == executionId, "Independent envelope kind/version/execution differ.");
        Program.Require(JsonElement.DeepEquals(envelope.GetProperty("scope"), Program.Element(scope)), "Independent full scope comparison failed.");
        Program.Require(envelope.GetProperty("recordId").ValueKind == (recordId is null ? JsonValueKind.Null : JsonValueKind.String) && (recordId is null || envelope.GetProperty("recordId").GetString() == recordId), "Independent record id differs.");
        Program.Require(JsonElement.DeepEquals(envelope.GetProperty("rootIdentity"), Program.Element(Identity(root))) && JsonElement.DeepEquals(envelope.GetProperty("reservationIdentity"), Program.Element(Identity(marker))) && JsonElement.DeepEquals(envelope.GetProperty("fileIdentity"), Program.Element(Identity(file))), "Independent actual identities differ from envelope.");
    }
    internal static uint GrantedAccess(SafeFileHandle handle)
    {
        var memory = Marshal.AllocHGlobal(56);
        try { var status = NtQueryObject(handle, 0, memory, 56, out _); Program.Require(status == 0, "Independent granted-access query failed."); return unchecked((uint)Marshal.ReadInt32(memory, 4)); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    internal static void AddExtraAce(string path)
    {
        var file = new FileInfo(path); var security = file.GetAccessControl(AccessControlSections.Access);
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), FileSystemRights.Read, AccessControlType.Allow));
        file.SetAccessControl(security);
    }
    internal static void SetJunction(string alias, string target)
    {
        var substitute = Encoding.Unicode.GetBytes(@"\??\" + Path.GetFullPath(target));
        var print = Encoding.Unicode.GetBytes(Path.GetFullPath(target));
        var dataLength = checked(8 + substitute.Length + 2 + print.Length + 2);
        var bytes = new byte[8 + dataLength];
        BitConverter.GetBytes(0xa0000003u).CopyTo(bytes, 0);
        BitConverter.GetBytes(checked((ushort)dataLength)).CopyTo(bytes, 4);
        BitConverter.GetBytes(checked((ushort)substitute.Length)).CopyTo(bytes, 10);
        BitConverter.GetBytes(checked((ushort)(substitute.Length + 2))).CopyTo(bytes, 12);
        BitConverter.GetBytes(checked((ushort)print.Length)).CopyTo(bytes, 14);
        substitute.CopyTo(bytes, 16); print.CopyTo(bytes, 16 + substitute.Length + 2);
        using var directory = CreateFileW(alias, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        Check(!directory.IsInvalid, "independent_junction_open");
        Check(DeviceIoControl(directory, 0x000900a4, bytes, checked((uint)bytes.Length), IntPtr.Zero, 0, out _, IntPtr.Zero), "independent_junction_create");
    }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct FileStandard { internal long AllocationSize, EndOfFile; internal uint Links; [MarshalAs(UnmanagedType.U1)] internal bool DeletePending; [MarshalAs(UnmanagedType.U1)] internal bool Directory; }
    [StructLayout(LayoutKind.Sequential)] private struct FileBasic { internal long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; internal uint Attributes; }
    // Native FILE_RENAME_INFORMATION has a BOOLEAN followed by x64 padding.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct FileRenameInformation { internal byte ReplaceIfExists; internal IntPtr RootDirectory; internal uint FileNameLength; internal ushort FileName; }
    [StructLayout(LayoutKind.Sequential)] private struct IoStatusBlock { internal IntPtr StatusOrPointer; internal UIntPtr Information; }
    [StructLayout(LayoutKind.Sequential)] private struct JobAccounting { internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] private struct JobProcessIdList { internal uint NumberOfAssignedProcesses, NumberOfProcessIdsInList; internal UIntPtr FirstProcessId; }
    [StructLayout(LayoutKind.Sequential)] private struct JobBasicLimits { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct JobIoCounters { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JobExtendedLimits { internal JobBasicLimits Basic; internal JobIoCounters Io; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DuplicateHandle(IntPtr sourceProcess, SafeProcessHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetProcessId(SafeHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(SafeHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(SafeHandle process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(SafeHandle process, uint exitCode);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenProcessToken(SafeHandle process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetTokenInformation(SafeFileHandle token, int informationClass, IntPtr information, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeFileHandle CreateJobObjectW(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(SafeHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref JobExtendedLimits information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out JobExtendedLimits information, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out JobAccounting accounting, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, IntPtr information, uint length, out uint returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool WriteFile(SafeFileHandle handle, byte[] bytes, uint length, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("ntdll.dll")] private static extern int NtSetInformationFile(SafeFileHandle handle, IntPtr ioStatus, IntPtr information, uint bytes, int informationClass);
    [DllImport("ntdll.dll")] private static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, IntPtr information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileStandard information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileBasic information, uint bytes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumePathNameW(string path, StringBuilder mount, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeNameForVolumeMountPointW(string mount, StringBuilder name, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder name, uint nameLength, out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder filesystem, uint filesystemLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder? path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateHardLinkW(string newName, string existingName, IntPtr security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DeleteFileW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool MoveFileExW(string oldName, string newName, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
    [DllImport("ntdll.dll")] private static extern int NtQueryObject(SafeFileHandle handle, int informationClass, IntPtr information, uint length, out uint returned);
}
