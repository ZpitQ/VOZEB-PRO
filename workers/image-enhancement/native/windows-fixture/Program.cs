using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsFixture;

internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    internal static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    internal static string Executable => Environment.ProcessPath ?? throw new InvalidOperationException("No apphost path.");

    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows fixture only.");
        try
        {
            switch (args[0])
            {
                case "direct":
                    WriteMarker(args[1], "direct-first-action");
                    Console.OutputEncoding = Utf8;
                    using (var self = ProcessPin.OpenSelf())
                        Console.WriteLine(JsonSerializer.Serialize(new { identity = self.IdentityJson, handle = self.HandleValue, handleValid = self.Valid, securityControl = Probe.ProtectedJobControl() }, Json));
                    Console.Error.WriteLine("direct-stderr");
                    return 0;
                case "engine":
                    return await RunEngineAsync(args);
                case "inspect-core":
                    Console.OutputEncoding = Utf8;
                    var context = new AssemblyLoadContext("ordinary-core-inspection", isCollectible: true);
                    try
                    {
                        var assembly = context.LoadFromAssemblyPath(Path.GetFullPath(args[1]));
                        var type = assembly.GetType("Zeb.WindowsSupervisor.JobProcess", throwOnError: true)!;
                        var hasFailureMethod = type.GetMethod("PrepareForTest") is not null;
                        var hasFailureEnum = assembly.GetType("Zeb.WindowsSupervisor.PrepareFailurePoint") is not null;
                        Console.WriteLine(JsonSerializer.Serialize(new { hasFailureMethod, hasFailureEnum }, Json));
                        return hasFailureMethod || hasFailureEnum ? 1 : 0;
                    }
                    finally { context.Unload(); }
                case "harness":
                    Console.OutputEncoding = Utf8;
                    Console.InputEncoding = Utf8;
                    await using (var harness = new Harness(args[1], int.Parse(args[2], CultureInfo.InvariantCulture), int.Parse(args[3], CultureInfo.InvariantCulture)))
                        await harness.RunAsync();
                    return 0;
                default:
                    throw new ArgumentException("Unknown fixture mode.");
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"{error.GetType().Name}: {error.Message}");
            return 1;
        }
    }

    private static void WriteMarker(string path, string text)
    {
        using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var writer = new StreamWriter(file, Utf8);
        writer.Write(text);
    }

    internal static string[] EngineArgs(string directory, string role, string pipePrefix, string eventPrefix, int executionMs, string sentinelHandle, IReadOnlyList<string> literals)
        => ["engine", directory, role, pipePrefix, eventPrefix, executionMs.ToString(CultureInfo.InvariantCulture), sentinelHandle, .. literals];

    internal static Process StartEngine(string[] argv, bool redirect = false)
    {
        var start = new ProcessStartInfo(Executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = redirect, RedirectStandardError = redirect };
        foreach (var value in argv) start.ArgumentList.Add(value);
        var process = Process.Start(start) ?? throw new InvalidOperationException("Fixture process was not created.");
        process.StandardInput.Close();
        return process;
    }

    private static async Task<int> RunEngineAsync(string[] args)
    {
        var directory = args[1];
        var role = args[2];
        // This is the first application side effect, before IPC, handles, or children.
        WriteMarker(Path.Combine(directory, role + ".marker"), role + "-first-action");
        Console.OutputEncoding = Utf8;
        using var deadline = new CancellationTokenSource(int.Parse(args[5], CultureInfo.InvariantCulture));
        using var self = ProcessPin.OpenSelf();
        using var exitEvent = EventWaitHandle.OpenExisting(args[4] + "-" + role);
        using var pipe = new NamedPipeClientStream(".", args[3] + "-" + role, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(deadline.Token);
        using var reader = new StreamReader(pipe, Utf8, false, leaveOpen: true);
        using var writer = new StreamWriter(pipe, Utf8, leaveOpen: true) { AutoFlush = true };
        var sentinelSetSucceeded = role == "parent" && Probe.SetEvent(new IntPtr(long.Parse(args[6], CultureInfo.InvariantCulture)));
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { @event = "ready", role, identity = self.IdentityJson, handle = self.HandleValue, handleValid = self.Valid, argv = args.Skip(7).ToArray(), sentinelSetSucceeded }, Json));
        Console.WriteLine("stdout:" + role);
        Console.Error.WriteLine("stderr:" + role);
        Process? child = null;
        Task<string?>? pendingRead = null;
        var exit = Probe.WaitAsync(exitEvent, deadline.Token);
        try
        {
            while (true)
            {
                pendingRead = reader.ReadLineAsync(deadline.Token).AsTask();
                if (await Task.WhenAny(pendingRead, exit) == exit) { await exit; return 0; }
                var line = await pendingRead;
                pendingRead = null;
                if (line is null) throw new EndOfStreamException("Fixture owner pipe closed.");
                using var request = JsonDocument.Parse(line);
                var op = request.RootElement.GetProperty("op").GetString();
                object reply;
                if (op == "spawn")
                {
                    if (child is not null || role is not ("parent" or "child")) throw new InvalidOperationException("Fixture spawn is once per non-leaf role.");
                    var childRole = role == "parent" ? "child" : "grandchild";
                    child = StartEngine(EngineArgs(directory, childRole, args[3], args[4], int.Parse(args[5], CultureInfo.InvariantCulture), args[6], args.Skip(7).ToArray()));
                    reply = new { @event = "spawned", pid = child.Id };
                }
                else if (op == "ping" || op == "observe")
                {
                    // This independently opened Job handle closes before the reply.
                    reply = self.Observe(request.RootElement.GetProperty("jobName").GetString()!);
                }
                else throw new ArgumentException("Unknown fixture peer operation.");
                await writer.WriteLineAsync(JsonSerializer.Serialize(reply, Json));
            }
        }
        finally
        {
            deadline.Cancel();
            if (pendingRead is not null)
            {
                try { await pendingRead; }
                catch (OperationCanceledException) { }
            }
            child?.Dispose(); // Closing this handle deliberately does not stop its descendants.
        }
    }
}

internal sealed class Harness : IAsyncDisposable
{
    private readonly string directory;
    private readonly int executionMs;
    private readonly int cleanupMs;
    private readonly string pipePrefix = "ZebTest-" + Guid.NewGuid().ToString("N");
    private readonly string eventPrefix = @"Local\ZebTest-" + Guid.NewGuid().ToString("N");
    private readonly CancellationTokenSource deadline;
    private readonly Dictionary<string, EventWaitHandle> exits = [];
    private readonly Dictionary<string, Peer> peers = [];
    private readonly Dictionary<string, ProcessPin> pins = [];
    private readonly SafeFileHandle sentinel;
    private readonly OwnershipGuard ownership = new();
    private JobProcess? subject;
    private Task<Drain>? stdout;
    private Task<Drain>? stderr;
    private Task<JobTreeExit>? treeWait;
    private string[] literals = [];
    private string? jobName;
    private bool disposed;
    private bool cleaned;
    private Exception? cleanupFailure;
    private Process? control;
    private Task<Drain>? controlStdout;
    private Task<Drain>? controlStderr;

    internal Harness(string directory, int executionMs, int cleanupMs)
    {
        this.directory = directory;
        this.executionMs = executionMs;
        this.cleanupMs = cleanupMs;
        deadline = new CancellationTokenSource(executionMs);
        foreach (var role in new[] { "parent", "child", "grandchild", "control" })
        {
            var exit = new EventWaitHandle(false, EventResetMode.ManualReset, eventPrefix + "-" + role, out var created);
            if (!created) throw new InvalidOperationException("Fixture event name collision.");
            exits.Add(role, exit);
            peers.Add(role, new Peer(pipePrefix + "-" + role));
        }
        var security = new Probe.SecurityAttributes { Length = Marshal.SizeOf<Probe.SecurityAttributes>(), InheritHandle = true };
        sentinel = Probe.CreateEventW(ref security, true, false, null);
        Probe.Check(!sentinel.IsInvalid, "CreateEventW");
    }

    private JobProcess Subject => subject ?? throw new InvalidOperationException("Subject not prepared.");
    private string JobName => jobName ?? throw new InvalidOperationException("No original Job identity.");
    private string Marker(string role) => Path.Combine(directory, role + ".marker");
    private string[] Arguments(string role) => Program.EngineArgs(directory, role, pipePrefix, eventPrefix, executionMs, sentinel.DangerousGetHandle().ToInt64().ToString(CultureInfo.InvariantCulture), literals);

    internal async Task RunAsync()
    {
        Console.WriteLine(JsonSerializer.Serialize(new { @event = "harness-ready", coreAssembly = typeof(JobProcess).Assembly.GetName().Name, testBuild = TestBuild }, Program.Json));
        while (await Console.In.ReadLineAsync(deadline.Token) is { } line)
        {
            using var request = JsonDocument.Parse(line);
            var root = request.RootElement;
            var id = root.GetProperty("id").GetInt32();
            var op = root.GetProperty("op").GetString()!;
            try
            {
                var value = await HandleAsync(op, root);
                Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, value }, Program.Json));
            }
            catch (Exception error)
            {
                var native = error as JobPreparationException;
                Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = new { type = error.GetType().Name, stage = native?.Stage ?? op, message = error.Message, nativeErrorCode = native?.NativeErrorCode } }, Program.Json));
            }
            if (op == "cleanup") return;
        }
    }

    private static bool TestBuild
    {
        get
        {
#if ZEB_NATIVE_TESTS
            return typeof(JobProcess).GetMethod("PrepareForTest") is not null;
#else
            return false;
#endif
        }
    }

    private async Task<object> HandleAsync(string op, JsonElement request)
    {
        switch (op)
        {
            case "prepare":
                if (subject is not null) throw new InvalidOperationException("One prepare per fixture harness.");
                if (request.TryGetProperty("argv", out var argv)) literals = argv.EnumerateArray().Select(value => value.GetString()!).ToArray();
                AttachSubject(JobProcess.Prepare(Program.Executable, Arguments("parent"), directory));
                return Prepared();
            case "inspect":
                return Prepared();
            case "inspect-native":
                // Production must reject disposal before the oracle opens any named Job.
                var observation = Subject.Inspect();
                return new { observation = new { engineIdentity = new { pid = observation.EngineIdentity.Pid, createdFileTime = observation.EngineIdentity.CreationFileTime.ToString(CultureInfo.InvariantCulture) }, observation.ProcessSignaled, observation.InOriginalJob, observation.ActiveProcesses, observation.TotalProcesses, observation.JobHandleFlags, observation.ProcessHandleFlags, observation.Authorized, observation.Sealed }, independent = Prepared() };
            case "tamper-job-security":
                return Probe.TamperEmptyJobSecurity(JobName, pins["parent"].Handle);
            case "authorize":
                return new { started = Subject.AuthorizeOnce(), isSealed = Subject.IsSealed };
            case "seal":
                Subject.Seal();
                return new { isSealed = Subject.IsSealed };
            case "force":
                Subject.Force();
                return new { accepted = true, isSealed = Subject.IsSealed };
            case "ready-tree":
                await ReadyAsync("parent");
                await peers["parent"].RequestAsync(new { op = "spawn" }, deadline.Token);
                await ReadyAsync("child");
                await peers["child"].RequestAsync(new { op = "spawn" }, deadline.Token);
                await ReadyAsync("grandchild");
                return await ObserveTreeAsync();
            case "observe-tree":
                return await ObserveTreeAsync();
            case "begin-wait":
                treeWait ??= Subject.WaitForTreeExitAsync(deadline.Token);
                return new { waitStarted = true };
            case "release":
                var role = request.GetProperty("role").GetString();
                var released = role switch { "all" => new[] { "parent", "child", "grandchild" }, "descendants" => new[] { "child", "grandchild" }, "parent" => new[] { "parent" }, _ => throw new ArgumentException("Unknown release role.") };
                foreach (var member in released) exits[member].Set();
                await Task.WhenAll(released.Select(member => pins[member].WaitAsync(deadline.Token)));
                return new { released };
            case "assert-wait-pending":
                if (treeWait is null) throw new InvalidOperationException("Tree wait not installed.");
                using (var grace = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token))
                {
                    grace.CancelAfter(cleanupMs);
                    var pending = false;
                    try { await treeWait.WaitAsync(grace.Token); }
                    catch (OperationCanceledException) when (!deadline.IsCancellationRequested) { pending = true; }
                    return new { pending, activeProcesses = Probe.ActiveProcesses(JobName), child = await ObservePeerAsync("child"), grandchild = await ObservePeerAsync("grandchild") };
                }
            case "join":
                Subject.Seal();
                treeWait ??= Subject.WaitForTreeExitAsync(deadline.Token);
                var treeExit = await treeWait;
                await Task.WhenAll(SubjectPins.Select(pin => pin.WaitAsync(deadline.Token)));
                var output = await stdout!;
                var errors = await stderr!;
                return new { treeExit, activeProcesses = Probe.ActiveProcesses(JobName), processes = SubjectPins.Select(pin => pin.Observe(JobName)).ToArray(), stdoutEof = output.Eof, stderrEof = errors.Eof, stdout = output.Lines, stderr = errors.Lines, markers = Markers(), isSealed = Subject.IsSealed };
            case "control-start":
                if (control is not null) throw new InvalidOperationException("One unrelated control.");
                control = Program.StartEngine(Arguments("control"), true);
                controlStdout = DrainAsync(control.StandardOutput.BaseStream, deadline.Token);
                controlStderr = DrainAsync(control.StandardError.BaseStream, deadline.Token);
                await ReadyAsync("control");
                return await ObservePeerAsync("control");
            case "ping-control":
                return await ObservePeerAsync("control");
            case "dispose":
                // All scoped Job query handles have already closed. Only process pins remain.
                Subject.Dispose();
                disposed = true;
                await Task.WhenAll(SubjectPins.Select(pin => pin.WaitAsync(deadline.Token)));
                return new { allExited = SubjectPins.All(pin => !pin.Alive), processes = SubjectPins.Select(pin => pin.Observe(null)).ToArray(), queryHandlesClosed = true };
            case "prepare-failure":
                return await PrepareFailureAsync(request.GetProperty("fault").GetString()!);
            case "guard-control":
                return await GuardControlAsync();
            case "cleanup":
                await CleanupAsync();
                return new { joined = pins.Values.All(pin => !pin.Alive), ownership = ownership.Evidence(deadline.Token) };
            default:
                throw new ArgumentException("Unknown harness operation.");
        }
    }

    private IEnumerable<ProcessPin> SubjectPins => pins.Where(pair => pair.Key != "control").Select(pair => pair.Value);
    private string[] Markers() => new[] { "parent", "child", "grandchild" }.Where(role => File.Exists(Marker(role))).ToArray();
    private object Prepared()
    {
        var pin = pins["parent"];
        var proof = Probe.ObserveJob(JobName, pin.Handle);
        var observed = pin.Observe(null);
        var engine = new Observation(observed.Identity, observed.Alive, observed.Alive && proof.InOriginalJob);
        return new { engine, jobName = JobName, proof.ActiveProcesses, proof.TotalProcesses, rawInOriginalJob = proof.InOriginalJob, proof.Security, proof.QueryHandleFlags, queryHandlesClosed = true, ownerHandleFlags = Probe.OriginalOwnerFlags(Subject), isPrepared = Subject.IsPrepared, isSealed = Subject.IsSealed, markerExists = File.Exists(Marker("parent")) };
    }

    private void AttachSubject(JobProcess prepared)
    {
        subject = prepared;
        // Both drains start immediately and before any authorize or observation.
        stdout = DrainAsync(prepared.StandardOutput, deadline.Token);
        stderr = DrainAsync(prepared.StandardError, deadline.Token);
        prepared.StandardInput.Dispose();
        jobName = prepared.JobName;
        pins.Add("parent", ProcessPin.Open(prepared.EngineIdentity));
    }

    private async Task ReadyAsync(string role)
    {
        var ready = await peers[role].ReadyAsync(deadline.Token);
        var identity = ProcessPin.ParseIdentity(ready.GetProperty("identity"));
        if (pins.TryGetValue(role, out var pin))
        {
            if (pin.Identity != identity) throw new InvalidOperationException("Original process identity changed.");
        }
        else pins.Add(role, ProcessPin.Open(identity));
        if (!ready.GetProperty("handleValid").GetBoolean()) throw new InvalidOperationException("Engine did not open a valid real process handle.");
    }

    private async Task<object> ObservePeerAsync(string role)
    {
        var selfObservation = await peers[role].RequestAsync(new { op = "ping", jobName = JobName }, deadline.Token);
        var independentlyObserved = pins[role].Observe(JobName);
        if (ProcessPin.ParseIdentity(selfObservation.GetProperty("identity")) != pins[role].Identity ||
            selfObservation.GetProperty("inOriginalJob").GetBoolean() != independentlyObserved.InOriginalJob)
            throw new InvalidOperationException("Engine self-probe disagrees with independently pinned process.");
        return independentlyObserved;
    }

    private async Task<object> ObserveTreeAsync()
        => new { parent = await ObservePeerAsync("parent"), child = await ObservePeerAsync("child"), grandchild = await ObservePeerAsync("grandchild"), activeProcesses = Probe.ActiveProcesses(JobName), argv = peers["parent"].Ready.GetProperty("argv").EnumerateArray().Select(value => value.GetString()!).ToArray(), sentinelSignaled = Probe.Signaled(sentinel) };

    private async Task<object> PrepareFailureAsync(string fault)
    {
        if (subject is not null || control is not null) throw new InvalidOperationException("Prepare failure probe requires its own child-free harness.");
        JobProcess? unexpected = null;
        try
        {
            if (fault == "MissingExecutable") unexpected = JobProcess.Prepare(Path.Combine(directory, Guid.NewGuid().ToString("N") + ".missing.exe"), Arguments("parent"), directory);
#if ZEB_NATIVE_TESTS
            else unexpected = JobProcess.PrepareForTest(Program.Executable, Arguments("parent"), directory, Enum.Parse<PrepareFailurePoint>(fault));
#else
            else throw new InvalidOperationException("Fault seam missing from fixture test build.");
#endif
            AttachSubject(unexpected);
            throw new InvalidOperationException("Injected native failure unexpectedly returned a process.");
        }
        catch (JobPreparationException error)
        {
            try
            {
                var liveBeforeReclaim = ownership.CaptureOwned(deadline.Token).Count(pin => pin.Alive);
                using var grace = new CancellationTokenSource(cleanupMs);
                await ownership.ReclaimAndJoinAsync(grace.Token);
                return new { failed = true, stage = error.Stage, nativeErrorCode = error.NativeErrorCode, markerExists = File.Exists(Marker("parent")), returnedProcess = false, liveBeforeReclaim, ownership = ownership.Evidence(grace.Token) };
            }
            catch (Exception guardError)
            {
                throw new AggregateException("Prepare failed and its independent ownership guard could not reclaim the created processes.", error, guardError);
            }
        }
    }

    private async Task<object> GuardControlAsync()
    {
        if (ownership.CaptureOwned(deadline.Token).Any(pin => pin.Alive)) throw new InvalidOperationException("Guard control requires no pre-existing child.");
        var marker = Path.Combine(directory, "guard-first-action.marker");
        // The creator's two handles close before the guard independently queries and pins it.
        var pid = Probe.CreateSuspendedMarker(Program.Executable, marker, directory);
        var observed = ownership.CaptureOwned(deadline.Token).Single(pin => pin.Identity.Pid == pid);
        var before = observed.Observe(null);
        var markerBeforeReclaim = File.Exists(marker);
        using var grace = new CancellationTokenSource(cleanupMs);
        await ownership.ReclaimAndJoinAsync(grace.Token);
        return new { detected = true, process = before, markerBeforeReclaim, markerAfterReclaim = File.Exists(marker), ownership = ownership.Evidence(grace.Token) };
    }

    private sealed record Drain(bool Eof, IReadOnlyList<string> Lines);
    private static async Task<Drain> DrainAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(stream, Program.Utf8, false, leaveOpen: true);
        var lines = new List<string>();
        while (await reader.ReadLineAsync(cancellationToken) is { } line) lines.Add(line);
        // Only an actual read returning EOF reaches here. Read/dispose faults propagate.
        return new Drain(true, lines);
    }

    private async Task CleanupAsync()
    {
        if (cleaned)
        {
            if (cleanupFailure is not null) throw cleanupFailure;
            return;
        }
        var failures = new List<Exception>();
        void Attempt(Action action) { try { action(); } catch (Exception error) { failures.Add(error); } }
        async Task AttemptAsync(Func<Task> action) { try { await action(); } catch (Exception error) { failures.Add(error); } }
        using var grace = new CancellationTokenSource(cleanupMs);
        Attempt(() => ownership.CaptureOwned(grace.Token));
        // The primitive is under test: each failure must still reach every independent cleanup step.
        if (subject is not null && !disposed)
        {
            Attempt(subject.Seal);
            Attempt(subject.Force);
        }
        foreach (var exit in exits.Values) Attempt(() => exit.Set());
        if (subject is not null && !disposed)
            await AttemptAsync(() => subject.WaitForTreeExitAsync(grace.Token).WaitAsync(grace.Token));
        if (control is not null) await AttemptAsync(() => control.WaitForExitAsync(grace.Token));
        await AttemptAsync(() => Task.WhenAll(pins.Values.Select(pin => pin.WaitAsync(grace.Token))));
        foreach (var drain in new[] { stdout, stderr })
        {
            if (drain is null) continue;
            await AttemptAsync(async () =>
            {
                try { await drain.WaitAsync(grace.Token); }
                // The close-only test makes no EOF claim after explicit primitive disposal.
                catch (ObjectDisposedException) when (disposed) { }
                catch (IOException) when (disposed) { }
            });
        }
        if (controlStdout is not null) await AttemptAsync(() => controlStdout.WaitAsync(grace.Token));
        if (controlStderr is not null) await AttemptAsync(() => controlStderr.WaitAsync(grace.Token));
        if (subject is not null && !disposed)
        {
            try { Attempt(subject.Dispose); }
            finally { disposed = true; }
        }
        using var exactJoin = new CancellationTokenSource(cleanupMs);
        await AttemptAsync(async () =>
        {
            if (await ownership.ReclaimAndJoinAsync(exactJoin.Token))
                failures.Add(new InvalidOperationException("Independent fixture ownership guard required emergency handle termination."));
        });
        // A guard-query failure must not skip the separately verified semantic/control pins.
        foreach (var pin in pins.Values)
            Attempt(() =>
            {
                if (!pin.Alive) return;
                failures.Add(new InvalidOperationException("Exact fixture pin required emergency handle termination."));
                pin.TerminateForCleanup();
            });
        await AttemptAsync(() => Task.WhenAll(pins.Values.Select(pin => pin.WaitAsync(exactJoin.Token))));
        Attempt(() => ownership.RequireNoLiveOwned(exactJoin.Token));
        cleaned = true;
        if (failures.Count > 0)
        {
            cleanupFailure = new AggregateException("Fixture cleanup failed after independent reclamation was attempted.", failures);
            throw cleanupFailure;
        }
    }

    public async ValueTask DisposeAsync()
    {
        var failures = new List<Exception>();
        void Release(Action action) { try { action(); } catch (Exception error) { failures.Add(error); } }
        try { await CleanupAsync(); }
        catch (Exception error) { failures.Add(error); }
        finally
        {
            // CleanupAsync always attempts subject disposal before releasing observation handles.
            Release(deadline.Cancel);
            foreach (var peer in peers.Values) Release(peer.Dispose);
            foreach (var pin in pins.Values) Release(pin.Dispose);
            foreach (var exit in exits.Values) Release(exit.Dispose);
            Release(sentinel.Dispose);
            if (control is not null) Release(control.Dispose);
            Release(ownership.Dispose);
            Release(deadline.Dispose);
        }
        if (failures.Count > 0) throw new AggregateException("Fixture disposal failed after resource reclamation.", failures);
    }
}

internal sealed class Peer : IDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly StreamReader reader;
    private readonly StreamWriter writer;
    private bool connected;
    internal JsonElement Ready { get; private set; }

    internal Peer(string name)
    {
        pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        reader = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true);
        writer = new StreamWriter(pipe, Program.Utf8, leaveOpen: true);
    }

    internal async Task<JsonElement> ReadyAsync(CancellationToken cancellationToken)
    {
        if (connected) return Ready;
        await pipe.WaitForConnectionAsync(cancellationToken);
        writer.AutoFlush = true;
        Ready = await ReadAsync(cancellationToken);
        if (Ready.GetProperty("event").GetString() != "ready") throw new InvalidDataException("Missing actual peer ready response.");
        connected = true;
        return Ready;
    }

    internal async Task<JsonElement> RequestAsync(object request, CancellationToken cancellationToken)
    {
        await writer.WriteLineAsync(JsonSerializer.Serialize(request, Program.Json).AsMemory(), cancellationToken);
        return await ReadAsync(cancellationToken);
    }

    private async Task<JsonElement> ReadAsync(CancellationToken cancellationToken)
    {
        var line = await reader.ReadLineAsync(cancellationToken) ?? throw new EndOfStreamException("Peer ended before its response.");
        using var document = JsonDocument.Parse(line);
        return document.RootElement.Clone();
    }

    public void Dispose()
    {
        try { writer.Dispose(); }
        catch (IOException) { }
        catch (InvalidOperationException) when (!connected) { }
        finally { reader.Dispose(); pipe.Dispose(); }
    }
}

internal sealed record Observation(object Identity, bool Alive, bool InOriginalJob);

// This unnamed outer Job observes only this harness's descendants, including an
// unreturned suspended engine. It never opens or retains the core's inner Job.
// The fresh Job has no breakaway or KILL_ON_JOB_CLOSE flags: closing it must not
// kill its harness member. This is a test cleanup guard, not crash containment.
internal sealed class OwnershipGuard : IDisposable
{
    private readonly SafeFileHandle job;
    private readonly Dictionary<ProcessIdentity, ProcessPin> observed = [];

    internal OwnershipGuard()
    {
        job = Probe.CreateJobObjectW(IntPtr.Zero, null);
        Probe.Check(!job.IsInvalid, "CreateJobObjectW(fixture guard)");
        try
        {
            using var self = ProcessPin.OpenSelf(Probe.ProcessSetQuota);
            Probe.Check(Probe.AssignProcessToJobObject(job, self.Handle), "AssignProcessToJobObject(fixture harness)");
            Probe.Check(Probe.InJob(self.Handle, job), "IsProcessInJob(fixture harness)");
        }
        catch { job.Dispose(); throw; }
    }

    internal ProcessPin[] CaptureOwned(CancellationToken cancellationToken)
    {
        var members = Probe.JobMembers(job, cancellationToken);
        if (!members.Contains((uint)Environment.ProcessId)) throw new InvalidOperationException("Harness is not a member of its independent ownership Job.");
        foreach (var pid in members.Where(pid => pid != (uint)Environment.ProcessId))
        {
            // Retaining the original process object also retains its PID/creation identity.
            if (observed.Values.Any(pin => pin.Identity.Pid == pid)) continue;
            var pin = ProcessPin.OpenOwned(pid, job);
            if (!observed.TryAdd(pin.Identity, pin)) pin.Dispose();
        }
        return observed.Values.ToArray();
    }

    internal async Task<bool> ReclaimAndJoinAsync(CancellationToken cancellationToken)
    {
        var reclaimed = false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var live = CaptureOwned(cancellationToken).Where(pin => pin.Alive).ToArray();
            if (live.Length == 0) return reclaimed;
            reclaimed = true;
            var failures = new List<Exception>();
            foreach (var pin in live)
            {
                try { if (pin.Alive) pin.TerminateForCleanup(); }
                catch (Exception error) { failures.Add(error); }
            }
            try { await Task.WhenAll(live.Select(pin => pin.WaitAsync(cancellationToken))); }
            catch (Exception error) { failures.Add(error); }
            if (failures.Count > 0) throw new AggregateException("Independent owned-process termination/join failed.", failures);
            // Every iteration joined real pinned processes. Requery only this Job to
            // capture descendants created before termination, with no polling delay.
        }
    }

    internal object Evidence(CancellationToken cancellationToken)
    {
        var pins = CaptureOwned(cancellationToken);
        var liveOwnedProcesses = pins.Count(pin => pin.Alive);
        return new { membershipVerified = true, observedOwnedProcessCount = pins.Length, liveOwnedProcesses, noLiveOwnedProcesses = liveOwnedProcesses == 0, allObservedJoined = pins.All(pin => !pin.Alive) };
    }

    internal void RequireNoLiveOwned(CancellationToken cancellationToken)
    {
        if (CaptureOwned(cancellationToken).Any(pin => pin.Alive)) throw new InvalidOperationException("Independent ownership Job still contains a live owned process.");
    }

    public void Dispose()
    {
        foreach (var pin in observed.Values) pin.Dispose();
        job.Dispose();
    }
}

internal sealed class ProcessPin : IDisposable
{
    private const uint QueryAndSynchronize = 0x00101000;
    private readonly SafeFileHandle handle;
    internal SafeFileHandle Handle => handle;
    internal ProcessIdentity Identity { get; }
    internal object IdentityJson => new { pid = Identity.Pid, createdFileTime = Identity.CreationFileTime.ToString(CultureInfo.InvariantCulture) };
    internal string HandleValue => handle.DangerousGetHandle().ToInt64().ToString(CultureInfo.InvariantCulture);
    internal bool Valid => Probe.GetHandleInformation(handle, out _) && Probe.GetProcessId(handle) == (uint)Identity.Pid;
    internal bool Alive => !Probe.Signaled(handle);

    private ProcessPin(SafeFileHandle handle, ProcessIdentity identity) { this.handle = handle; Identity = identity; }

    internal static ProcessIdentity ParseIdentity(JsonElement json)
        => new(json.GetProperty("pid").GetInt32(), ulong.Parse(json.GetProperty("createdFileTime").GetString()!, CultureInfo.InvariantCulture));

    internal static ProcessPin OpenSelf(uint additionalAccess = 0)
    {
        var handle = Probe.OpenProcess(QueryAndSynchronize | Probe.ProcessTerminate | additionalAccess, false, (uint)Environment.ProcessId);
        Probe.Check(!handle.IsInvalid, "OpenProcess");
        try { return new ProcessPin(handle, new ProcessIdentity(Environment.ProcessId, Probe.CreationTime(handle))); }
        catch { handle.Dispose(); throw; }
    }

    internal static ProcessPin Open(ProcessIdentity identity)
    {
        var handle = Probe.OpenProcess(QueryAndSynchronize | Probe.ProcessTerminate, false, (uint)identity.Pid);
        Probe.Check(!handle.IsInvalid, "OpenProcess");
        try
        {
            if (Probe.CreationTime(handle) != identity.CreationFileTime || Probe.GetProcessId(handle) != (uint)identity.Pid)
                throw new InvalidOperationException("PID/creation time does not identify the original process.");
            return new ProcessPin(handle, identity);
        }
        catch { handle.Dispose(); throw; }
    }

    internal static ProcessPin OpenOwned(uint pid, SafeFileHandle owningJob)
    {
        var handle = Probe.OpenProcess(QueryAndSynchronize | Probe.ProcessTerminate, false, pid);
        Probe.Check(!handle.IsInvalid, "OpenProcess(fixture-owned member)");
        try
        {
            if (Probe.GetProcessId(handle) != pid || !Probe.InJob(handle, owningJob))
                throw new InvalidOperationException("Queried member is not independently owned by the fixture Job.");
            return new ProcessPin(handle, new ProcessIdentity(checked((int)pid), Probe.CreationTime(handle)));
        }
        catch { handle.Dispose(); throw; }
    }

    internal Observation Observe(string? jobName)
    {
        var actualPid = Probe.GetProcessId(handle);
        Probe.Check(actualPid != 0, "GetProcessId(original fixture pin)");
        if (new ProcessIdentity(checked((int)actualPid), Probe.CreationTime(handle)) != Identity)
            throw new InvalidOperationException("Original fixture process identity changed.");
        var alive = Alive;
        return new Observation(IdentityJson, alive, alive && jobName is not null && Probe.InJob(handle, jobName));
    }

    internal async Task WaitAsync(CancellationToken cancellationToken)
    {
        using var wait = new ProcessWait(handle);
        await Probe.WaitAsync(wait, cancellationToken);
    }

    internal void TerminateForCleanup() => Probe.Check(Probe.TerminateProcess(handle, 1), "TerminateProcess(test cleanup)");
    public void Dispose() => handle.Dispose();

    private sealed class ProcessWait : WaitHandle
    {
        internal ProcessWait(SafeFileHandle handle) => SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), false);
    }
}

// Independent test probes only. Production native behavior belongs to the core.
internal sealed record JobSecurityEvidence(bool OwnerMatchesCurrentUser, bool DaclPresent, bool DaclProtected, int AceCount, bool PlainAllow, bool AceSidMatchesCurrentUser, int AceFlags, int AceMask, bool IsCallback, int OpaqueLength, bool AdditionalWorldQueryAce);
internal sealed record JobEvidence(uint ActiveProcesses, uint TotalProcesses, bool InOriginalJob, JobSecurityEvidence Security, uint QueryHandleFlags);
internal sealed record OwnerHandleFlags(uint JobHandleFlags, uint ProcessHandleFlags);

internal static class Probe
{
    internal const uint ProcessTerminate = 0x0001;
    internal const uint ProcessSetQuota = 0x0100;
    private const uint JobQuery = 0x0004;
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const int JobAllAccess = 0x001f003f;
    private const uint KernelObject = 6;
    private const uint OwnerAndDacl = 5;
    private const uint ProtectedDacl = 0x80000004;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccounting
    {
        internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal uint Size;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        internal ushort ShowWindow, Reserved2Bytes;
        internal IntPtr Reserved2, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    internal static void Check(bool success, string api)
    {
        if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), api + " failed in independent fixture probe.");
    }

    private static SecurityIdentifier CurrentUserSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User ?? throw new InvalidOperationException("Fixture current User SID is missing.");
    }

    private static RawAcl JobAcl(SecurityIdentifier sid, bool additionalQueryAce)
    {
        var acl = new RawAcl(GenericAcl.AclRevision, additionalQueryAce ? 2 : 1);
        acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, JobAllAccess, sid, false, null));
        if (additionalQueryAce)
            acl.InsertAce(1, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, (int)JobQuery, new SecurityIdentifier(WellKnownSidType.WorldSid, null), false, null));
        return acl;
    }

    internal static object ProtectedJobControl()
    {
        var sid = CurrentUserSid();
        var descriptor = new RawSecurityDescriptor(ControlFlags.SelfRelative | ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected, sid, null, null, JobAcl(sid, false));
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        SafeFileHandle creator;
        var name = @"Local\ZebTest-Security-" + Guid.NewGuid().ToString("N");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), SecurityDescriptor = pinned.AddrOfPinnedObject(), InheritHandle = false };
            creator = CreateProtectedJob(ref attributes, name);
            var error = Marshal.GetLastWin32Error();
            if (creator.IsInvalid || error == 183)
            {
                creator.Dispose();
                throw new System.ComponentModel.Win32Exception(error, "CreateJobObjectW(independent protected control) failed.");
            }
        }
        finally { pinned.Free(); }
        JobEvidence evidence;
        uint creatorHandleFlags;
        using (creator)
        {
            Check(GetHandleInformation(creator, out creatorHandleFlags), "GetHandleInformation(independent protected control)");
            evidence = ObserveJob(name, null);
        }
        return new { evidence, creatorHandleFlags, creatorHandleClosed = creator.IsClosed, queryHandlesClosed = true };
    }

    internal static JobEvidence ObserveJob(string name, SafeFileHandle? process)
    {
        using var job = OpenJobObjectW(JobQuery | ReadControl, false, name);
        Check(!job.IsInvalid, "OpenJobObjectW(independent observation)");
        Check(GetHandleInformation(job, out var flags), "GetHandleInformation(independent Job query)");
        Check(QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero), "QueryInformationJobObject(independent observation)");
        var member = process is not null && InJob(process, job);
        return new JobEvidence(accounting.ActiveProcesses, accounting.TotalProcesses, member, ReadJobSecurity(job), flags);
    }

    private static JobSecurityEvidence ReadJobSecurity(SafeFileHandle job)
    {
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            var code = GetSecurityInfo(job, KernelObject, OwnerAndDacl, out _, out _, out _, out _, out descriptor);
            if (code != 0) throw new System.ComponentModel.Win32Exception(checked((int)code), "GetSecurityInfo(independent Job query) failed.");
            if (descriptor == IntPtr.Zero) throw new InvalidDataException("Independent Job security descriptor is missing.");
            var length = GetSecurityDescriptorLength(descriptor);
            Check(length != 0, "GetSecurityDescriptorLength(independent Job query)");
            var bytes = new byte[checked((int)length)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0);
            var sid = CurrentUserSid();
            var acl = security.DiscretionaryAcl;
            var ace = acl is not null && acl.Count > 0 ? acl[0] as CommonAce : null;
            var extra = acl is not null && acl.Count == 2 ? acl[1] as CommonAce : null;
            var worldQuery = extra is not null && extra.AceType == AceType.AccessAllowed && extra.SecurityIdentifier.IsWellKnown(WellKnownSidType.WorldSid) && extra.AccessMask == JobQuery && extra.AceFlags == AceFlags.None && !extra.IsCallback && extra.OpaqueLength == 0;
            return new JobSecurityEvidence(security.Owner == sid, (security.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0, (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0, acl?.Count ?? 0, ace is not null && ace.AceType == AceType.AccessAllowed && !ace.IsCallback, ace?.SecurityIdentifier == sid, ace is null ? -1 : (int)ace.AceFlags, ace?.AccessMask ?? 0, ace?.IsCallback ?? false, ace?.OpaqueLength ?? -1, worldQuery);
        }
        finally
        {
            if (descriptor != IntPtr.Zero && LocalFree(descriptor) != IntPtr.Zero)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "LocalFree(independent Job descriptor) failed.");
        }
    }

    internal static OwnerHandleFlags OriginalOwnerFlags(JobProcess subject)
    {
        uint Read(string fieldName)
        {
            // Borrow only: never close, duplicate, alter, or return the owner handle.
            var field = typeof(JobProcess).GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic);
            if (field?.GetValue(subject) is not SafeHandle handle || handle.IsClosed || handle.IsInvalid)
                throw new InvalidOperationException("Original owner handle field is unavailable.");
            Check(GetHandleInformation(handle, out var flags), "GetHandleInformation(original borrowed owner)");
            return flags;
        }
        return new OwnerHandleFlags(Read("job"), Read("process"));
    }

    internal static object TamperEmptyJobSecurity(string name, SafeFileHandle process)
    {
        using (var job = OpenJobObjectW(JobQuery | ReadControl | WriteDac, false, name))
        {
            Check(!job.IsInvalid, "OpenJobObjectW(empty fixture Job mutation)");
            Check(QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero), "QueryInformationJobObject(empty fixture Job mutation)");
            var before = ReadJobSecurity(job);
            if (accounting.ActiveProcesses != 0 || !Signaled(process) || !before.OwnerMatchesCurrentUser || !before.DaclPresent || !before.DaclProtected || before.AceCount != 1 || !before.PlainAllow || !before.AceSidMatchesCurrentUser || before.AceFlags != 0 || before.AceMask != JobAllAccess || before.IsCallback || before.OpaqueLength != 0)
                throw new InvalidOperationException("Fixture security mutation requires its healthy empty original Job.");
            var acl = JobAcl(CurrentUserSid(), true);
            var bytes = new byte[acl.BinaryLength];
            acl.GetBinaryForm(bytes, 0);
            var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                var code = SetSecurityInfo(job, KernelObject, ProtectedDacl, IntPtr.Zero, IntPtr.Zero, pinned.AddrOfPinnedObject(), IntPtr.Zero);
                if (code != 0) throw new System.ComponentModel.Win32Exception(checked((int)code), "SetSecurityInfo(empty fixture Job mutation) failed.");
            }
            finally { pinned.Free(); }
        }
        var evidence = ObserveJob(name, process);
        if (evidence.ActiveProcesses != 0 || evidence.Security.AceCount != 2 || !evidence.Security.DaclProtected || !evidence.Security.OwnerMatchesCurrentUser || !evidence.Security.AdditionalWorldQueryAce)
            throw new InvalidDataException("Empty fixture Job security mutation was not independently observed.");
        return new { evidence, mutationHandleClosed = true, queryHandlesClosed = true };
    }

    internal static bool Signaled(SafeFileHandle handle)
    {
        var result = WaitForSingleObject(handle, 0);
        if (result == WaitObject0) return true;
        if (result == WaitTimeout) return false;
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
    }

    internal static ulong CreationTime(SafeFileHandle handle)
    {
        Check(GetProcessTimes(handle, out var creation, out _, out _, out _), "GetProcessTimes");
        return unchecked((ulong)creation);
    }

    internal static bool InJob(SafeFileHandle process, string jobName)
    {
        using var job = OpenJobObjectW(JobQuery, false, jobName);
        Check(!job.IsInvalid, "OpenJobObjectW");
        Check(IsProcessInJob(process, job, out var belongs), "IsProcessInJob");
        return belongs;
    }

    internal static bool InJob(SafeFileHandle process, SafeFileHandle job)
    {
        Check(IsProcessInJob(process, job, out var belongs), "IsProcessInJob(fixture ownership)");
        return belongs;
    }

    internal static uint[] JobMembers(SafeFileHandle job, CancellationToken cancellationToken)
    {
        Check(QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero), "QueryInformationJobObject(fixture accounting)");
        var capacity = accounting.ActiveProcesses;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var bytes = checked(8 + checked((int)capacity) * IntPtr.Size);
            var buffer = Marshal.AllocHGlobal(bytes);
            try
            {
                Marshal.WriteInt32(buffer, 0);
                Marshal.WriteInt32(buffer, 4, 0);
                if (!QueryInformationJobObject(job, 3, buffer, checked((uint)bytes), out var requiredBytes))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 234) throw new System.ComponentModel.Win32Exception(error, "QueryInformationJobObject(fixture member list) failed.");
                    var assigned = checked((uint)Marshal.ReadInt32(buffer));
                    var requiredCapacity = requiredBytes > 8 ? (requiredBytes - 8) / checked((uint)IntPtr.Size) : 0;
                    var larger = Math.Max(assigned, requiredCapacity);
                    if (larger <= capacity) throw new InvalidDataException("Fixture Job member list did not provide a larger required buffer.");
                    capacity = larger;
                    continue;
                }
                var count = checked((uint)Marshal.ReadInt32(buffer, 4));
                if (count > capacity) throw new InvalidDataException("Fixture Job member list exceeds its real buffer.");
                return Enumerable.Range(0, checked((int)count)).Select(index => checked((uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64())).ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    internal static int CreateSuspendedMarker(string executable, string marker, string directory)
    {
        var startup = new StartupInfo { Size = (uint)Marshal.SizeOf<StartupInfo>() };
        // Windows file names cannot contain quotes; these fixed arguments end in file names.
        var commandLine = new StringBuilder($"\"{executable}\" direct \"{marker}\"");
        Check(CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x00000004 | 0x08000000, IntPtr.Zero, directory, ref startup, out var process), "CreateProcessW(suspended fixture guard control)");
        using var processHandle = new SafeFileHandle(process.Process, true);
        using var threadHandle = new SafeFileHandle(process.Thread, true);
        return checked((int)process.ProcessId);
    }

    internal static uint ActiveProcesses(string jobName)
    {
        using var job = OpenJobObjectW(JobQuery, false, jobName);
        Check(!job.IsInvalid, "OpenJobObjectW");
        Check(QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero), "QueryInformationJobObject");
        return accounting.ActiveProcesses;
    }

    internal static async Task WaitAsync(WaitHandle handle, CancellationToken cancellationToken)
    {
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = ThreadPool.RegisterWaitForSingleObject(handle, (_, timedOut) =>
        {
            if (!timedOut) completed.TrySetResult();
        }, null, Timeout.Infinite, true);
        using var canceled = cancellationToken.Register(() => completed.TrySetCanceled(cancellationToken));
        try { await completed.Task; }
        finally { registration.Unregister(null); }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessId(SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeFileHandle CreateEventW(ref SecurityAttributes security, [MarshalAs(UnmanagedType.Bool)] bool manualReset, [MarshalAs(UnmanagedType.Bool)] bool initialState, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeFileHandle CreateJobObjectW(IntPtr security, string? name);
    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateProtectedJob(ref SecurityAttributes security, string name);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    private static extern uint SetSecurityInfo(SafeFileHandle handle, uint objectType, uint securityInformation, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out BasicAccounting information, uint informationLength, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, IntPtr information, uint informationLength, out uint returnedLength);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
}
