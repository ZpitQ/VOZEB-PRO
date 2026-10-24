using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsRootExitFixture;

internal static class Program
{
    private const int RootExitCode = 23;
    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static string Executable => Environment.ProcessPath ?? throw new InvalidOperationException("Fixture apphost is unavailable.");

    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        Console.InputEncoding = Utf8;
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows fixture only.");
            return args[0] switch
            {
                "case" => await RunCaseAsync(args),
                "root" => await RunRootAsync(args),
                "descendant" => RunDescendant(args),
                _ => throw new ArgumentException("Unknown fixture mode.")
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"{error.GetType().Name}: {error.Message}");
            return 1;
        }
    }

    private static async Task<int> RunCaseAsync(string[] args)
    {
        string scenario = args[1], directory = Path.GetFullPath(args[2]);
        int executionMs = int.Parse(args[3], CultureInfo.InvariantCulture);
        int cleanupMs = int.Parse(args[4], CultureInfo.InvariantCulture);
        if (scenario is not ("suspended-natural" or "root-before-descendant" or "caller-cancellation" or "dispose-live"))
            throw new ArgumentException("Unknown root-exit case.");
        if (!Directory.Exists(directory) || Directory.EnumerateFileSystemEntries(directory).Any())
            throw new ArgumentException("An existing empty fixture directory is required.");

        using var deadline = new CancellationTokenSource(executionMs);
        string prefix = "Zeb-root-exit-" + Guid.NewGuid().ToString("N");
        using var releaseRoot = new EventWaitHandle(false, EventResetMode.ManualReset, @"Local\" + prefix + "-root");
        using var childReady = new EventWaitHandle(false, EventResetMode.ManualReset, @"Local\" + prefix + "-child-ready");
        using var releaseChild = new EventWaitHandle(false, EventResetMode.ManualReset, @"Local\" + prefix + "-child");
        using var pipe = new NamedPipeServerStream(prefix, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var failures = new List<string>();
        var facts = new Dictionary<string, object?> { ["scenario"] = scenario };
        var pins = new List<ProcessPin>();
        var rootTasks = new List<Task<ProcessRootExit>>();
        JobProcess? job = null;
        Task<Drain>? stdout = null, stderr = null;
        JobTreeExit? treeExit = null;
        bool disposed = false, forceRequested = false, allPinnedJoined = false;
        bool hasChild = scenario == "root-before-descendant";
        try
        {
            var ownerIdentity = Native.Identity(new IntPtr(-1));
            job = JobProcess.Prepare(Executable,
                ["root", directory, prefix, hasChild ? "yes" : "no", ownerIdentity.Pid.ToString(CultureInfo.InvariantCulture),
                    ownerIdentity.CreationFileTime.ToString(CultureInfo.InvariantCulture), executionMs.ToString(CultureInfo.InvariantCulture)], directory);
            stdout = DrainAsync(job.StandardOutput);
            stderr = DrainAsync(job.StandardError);
            var prepared = job.Inspect();
            facts["prepared"] = new
            {
                identity = IdentityJson(prepared.EngineIdentity), prepared.ProcessSignaled, prepared.InOriginalJob,
                prepared.ActiveProcesses, prepared.TotalProcesses, prepared.Authorized,
                markerExists = File.Exists(Path.Combine(directory, "root.marker"))
            };
            Require(!prepared.ProcessSignaled && prepared.InOriginalJob && !prepared.Authorized && prepared.ActiveProcesses == 1 && prepared.TotalProcesses == 1,
                "Original prepared root was not live, suspended and alone in its original Job.");
            Task<ProcessRootExit>? rootWait = null;
            if (scenario == "suspended-natural")
            {
                rootWait = Track(job.WaitForProcessExitAsync());
                bool markerAbsent = !File.Exists(Path.Combine(directory, "root.marker"));
                facts["beforeAuthorization"] = new { pending = !rootWait.IsCompleted, markerAbsent };
                Require(!rootWait.IsCompleted && markerAbsent, "Root wait completed before authorization or a suspended root ran its marker.");
            }

            Require(job.AuthorizeOnce(), "Original root was not authorized exactly once.");
            await pipe.WaitForConnectionAsync(deadline.Token);
            using (var readyReader = new StreamReader(pipe, Utf8, false, leaveOpen: true))
            {
                var line = await readyReader.ReadLineAsync(deadline.Token) ?? throw new EndOfStreamException("Root ready proof was not received.");
                var ready = JsonSerializer.Deserialize<Ready>(line, Json) ?? throw new InvalidDataException("Root ready proof is null.");
                pins.Add(ProcessPin.Take(ready.Root));
                if (ready.Descendant is not null) pins.Add(ProcessPin.Take(ready.Descendant));
            }
            Require(pins.Count == (hasChild ? 2 : 1), "Ready proof did not pin the exact expected process count.");
            Require(pins[0].Identity == job.EngineIdentity, "Duplicated original root object did not match EngineIdentity.");
            foreach (var pin in pins) pin.VerifyOriginalJob(job.JobName);
            Require(File.ReadAllText(Path.Combine(directory, "root.marker"), Utf8) == "root-first-action", "Original root first-action marker was not written.");
            facts["readyPins"] = pins.Select(pin => new { identity = IdentityJson(pin.Identity), alive = pin.Alive, pin.InOriginalJob, pin.Source }).ToArray();

            if (scenario == "caller-cancellation")
            {
                using var caller = new CancellationTokenSource();
                var cancelledWait = Track(job.WaitForProcessExitAsync(caller.Token));
                rootWait = Track(job.WaitForProcessExitAsync());
                caller.Cancel();
                bool cancelled = false;
                try { await cancelledWait.WaitAsync(deadline.Token); }
                catch (OperationCanceledException) when (caller.IsCancellationRequested && !deadline.IsCancellationRequested) { cancelled = true; }
                facts["cancellation"] = new { cancelled, otherPending = !rootWait.IsCompleted, originalRootAlive = pins[0].Alive };
                Require(cancelled && !rootWait.IsCompleted && pins[0].Alive, "Caller cancellation cancelled shared observation, killed the root, or did not cancel only its own wait.");
            }
            else rootWait ??= Track(job.WaitForProcessExitAsync());

            if (scenario == "dispose-live")
            {
                Require(pins[0].Alive && !rootWait.IsCompleted, "Dispose case did not begin with a live root and pending observation.");
                job.Dispose();
                disposed = true;
                bool faulted = false;
                try { await rootWait.WaitAsync(deadline.Token); }
                catch (ObjectDisposedException) { faulted = true; }
                await pins[0].JoinAsync(deadline.Token);
                facts["disposedObservation"] = new { faulted, rootPhysicallyExited = !pins[0].Alive, actualExitCode = pins[0].ExitCode };
                Require(faulted && !pins[0].Alive, "Dispose fabricated a successful root result or did not physically contain the original process.");
            }
            else
            {
                var pendingTree = job.WaitForTreeExitAsync();
                releaseRoot.Set();
                var rootExit = await rootWait.WaitAsync(deadline.Token);
                await pins[0].JoinAsync(deadline.Token);
                var repeated = await Track(job.WaitForProcessExitAsync()).WaitAsync(deadline.Token);
                facts["rootExit"] = new { identity = IdentityJson(rootExit.Identity), rootExit.ExitCode, pinnedExitCode = pins[0].ExitCode, repeatedSame = repeated == rootExit };
                Require(rootExit.Identity == job.EngineIdentity && rootExit.ExitCode == RootExitCode && pins[0].ExitCode == RootExitCode && repeated == rootExit,
                    "Root result did not preserve the original process identity, actual native exit code, and repeat result.");
                if (hasChild)
                {
                    var observation = job.Inspect();
                    facts["descendantStillLive"] = new
                    {
                        pendingTree = !pendingTree.IsCompleted, observation.ActiveProcesses, observation.TotalProcesses,
                        alive = pins[1].Alive, identity = IdentityJson(pins[1].Identity), pins[1].InOriginalJob
                    };
                    Require(!pendingTree.IsCompleted && observation.ActiveProcesses == 1 && observation.TotalProcesses == 2 && pins[1].Alive,
                        "Root completion was not distinct from the still-live original Job descendant.");
                    job.Force();
                    forceRequested = true;
                }
                treeExit = await pendingTree.WaitAsync(deadline.Token);
                Require(treeExit.ActiveProcesses == 0 && treeExit.EngineExitCode == RootExitCode, "Original Job tree result did not retain the natural root exit.");
                if (scenario == "suspended-natural")
                {
                    var naturalStdout = await stdout.WaitAsync(deadline.Token);
                    var naturalStderr = await stderr.WaitAsync(deadline.Token);
                    Require(naturalStdout.Eof && naturalStderr.Eof, "Natural root streams did not reach EOF before owner disposal.");
                    job.Dispose();
                    disposed = true;
                    var afterDispose = await Track(job.WaitForProcessExitAsync()).WaitAsync(deadline.Token);
                    facts["afterDispose"] = new { sameOriginalResult = afterDispose == rootExit, identity = IdentityJson(afterDispose.Identity), afterDispose.ExitCode };
                    Require(afterDispose == rootExit, "Owner disposal erased or replaced the already-observed original root result.");
                }
            }
        }
        catch (Exception error) { failures.Add($"{error.GetType().Name}: {error.Message}"); }
        finally
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            try
            {
                if (job is not null && !disposed)
                {
                    if (treeExit is null)
                    {
                        job.Force();
                        forceRequested = true;
                        treeExit = await job.WaitForTreeExitAsync(cleanup.Token);
                    }
                    Require(treeExit.ActiveProcesses == 0, "Fixture cleanup did not join the original Job tree.");
                }
                foreach (var pin in pins) await pin.JoinAsync(cleanup.Token);
                allPinnedJoined = pins.All(pin => !pin.Alive);
            }
            catch (Exception error) { failures.Add($"cleanup {error.GetType().Name}: {error.Message}"); }
            Drain? outDrain = null, errDrain = null;
            try
            {
                if (stdout is not null) outDrain = await stdout.WaitAsync(cleanup.Token);
                if (stderr is not null) errDrain = await stderr.WaitAsync(cleanup.Token);
                if (!disposed)
                    Require(outDrain?.Eof == true && errDrain?.Eof == true, "Original root streams did not both reach natural EOF.");
            }
            catch (Exception error) { failures.Add($"streams {error.GetType().Name}: {error.Message}"); }
            facts["cleanup"] = new
            {
                forceRequested, disposed, treeExit, expectedPins = hasChild ? 2 : 1, observedPins = pins.Count,
                allPinnedJoined, stdout = outDrain, stderr = errDrain,
                pins = pins.Select(pin => new { identity = IdentityJson(pin.Identity), alive = pin.Alive, actualExitCode = pin.Alive ? (uint?)null : pin.ExitCode }).ToArray()
            };
            try { if (!disposed) job?.Dispose(); }
            catch (Exception error) { failures.Add($"dispose {error.GetType().Name}: {error.Message}"); }
            foreach (var task in rootTasks)
                if (task.IsFaulted) _ = task.Exception;
            foreach (var pin in pins) pin.Dispose();
        }
        facts["passed"] = failures.Count == 0;
        facts["failures"] = failures;
        Console.WriteLine(JsonSerializer.Serialize(facts, Json));
        return failures.Count == 0 ? 0 : 1;

        Task<ProcessRootExit> Track(Task<ProcessRootExit> task) { rootTasks.Add(task); return task; }
    }

    private static async Task<int> RunRootAsync(string[] args)
    {
        string directory = args[1], prefix = args[2];
        int executionMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        WriteMarker(Path.Combine(directory, "root.marker"), "root-first-action");
        Console.WriteLine("root-stdout");
        Console.Error.WriteLine("root-stderr");
        using var release = EventWaitHandle.OpenExisting(@"Local\" + prefix + "-root");
        using var childReady = EventWaitHandle.OpenExisting(@"Local\" + prefix + "-child-ready");
        using var host = Native.OpenDuplicateTarget(int.Parse(args[4], CultureInfo.InvariantCulture), ulong.Parse(args[5], CultureInfo.InvariantCulture));
        Process? child = null;
        try
        {
            HandleProof? descendant = null;
            if (args[3] == "yes")
            {
                var start = new ProcessStartInfo(Executable) { UseShellExecute = false, CreateNoWindow = true };
                foreach (var value in new[] { "descendant", directory, prefix, args[6] }) start.ArgumentList.Add(value);
                child = Process.Start(start) ?? throw new InvalidOperationException("Descendant was not created.");
                Require(childReady.WaitOne(executionMs), "Original descendant did not reach its explicit ready gate.");
                descendant = Native.DuplicateForHost(child.SafeHandle.DangerousGetHandle(), host, "original-create-process-child-object");
            }
            var root = Native.DuplicateForHost(new IntPtr(-1), host, "original-root-self-process-object");
            using var pipe = new NamedPipeClientStream(".", prefix, PipeDirection.Out, PipeOptions.Asynchronous);
            using var connectDeadline = new CancellationTokenSource(executionMs);
            await pipe.ConnectAsync(connectDeadline.Token);
            await using (var writer = new StreamWriter(pipe, Utf8, leaveOpen: true) { AutoFlush = true })
                await writer.WriteLineAsync(JsonSerializer.Serialize(new Ready(root, descendant), Json));
            Require(release.WaitOne(executionMs), "Root release gate expired.");
            return RootExitCode;
        }
        finally { child?.Dispose(); }
    }

    private static int RunDescendant(string[] args)
    {
        WriteMarker(Path.Combine(args[1], "descendant.marker"), "descendant-first-action");
        Console.WriteLine("descendant-stdout");
        Console.Error.WriteLine("descendant-stderr");
        using var ready = EventWaitHandle.OpenExisting(@"Local\" + args[2] + "-child-ready");
        using var release = EventWaitHandle.OpenExisting(@"Local\" + args[2] + "-child");
        ready.Set();
        Require(release.WaitOne(int.Parse(args[3], CultureInfo.InvariantCulture)), "Descendant release gate expired.");
        return 0;
    }

    private static Task<Drain> DrainAsync(Stream stream) => Task.Run(async () =>
    {
        try
        {
            using var reader = new StreamReader(stream, Utf8, false, leaveOpen: true);
            return new Drain(true, await reader.ReadToEndAsync(), null);
        }
        catch (Exception error) { return new Drain(false, null, $"{error.GetType().Name}: {error.Message}"); }
    });

    private static object IdentityJson(ProcessIdentity identity) => new { identity.Pid, creationFileTime = identity.CreationFileTime.ToString(CultureInfo.InvariantCulture) };
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static void WriteMarker(string path, string value)
    {
        using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var writer = new StreamWriter(file, Utf8);
        writer.Write(value);
    }

    private sealed record Drain(bool Eof, string? Text, string? Error);
    private sealed record HandleProof(int Pid, string CreationFileTime, string Handle, string Source);
    private sealed record Ready(HandleProof Root, HandleProof? Descendant);

    private sealed class ProcessPin(SafeFileHandle handle, ProcessIdentity identity, string source) : IDisposable
    {
        public ProcessIdentity Identity { get; } = identity;
        public string Source { get; } = source;
        public bool InOriginalJob { get; private set; }
        public bool Alive => Native.IsAlive(handle);
        public uint ExitCode
        {
            get
            {
                Require(!Alive, "A live observation pin has no exit proof.");
                Native.Check(Native.GetExitCodeProcess(handle, out var code), "GetExitCodeProcess(test pin)");
                return code;
            }
        }

        public static ProcessPin Take(HandleProof proof)
        {
            var handle = new SafeFileHandle(new IntPtr(long.Parse(proof.Handle, CultureInfo.InvariantCulture)), true);
            try
            {
                Require(!handle.IsInvalid, "Transferred original process handle is invalid.");
                var identity = Native.Identity(handle.DangerousGetHandle());
                Require(identity == new ProcessIdentity(proof.Pid, ulong.Parse(proof.CreationFileTime, CultureInfo.InvariantCulture)), "Transferred process object identity changed.");
                return new ProcessPin(handle, identity, proof.Source);
            }
            catch { handle.Dispose(); throw; }
        }

        public void VerifyOriginalJob(string name)
        {
            // A query handle would delay kill-on-last-close, so it never survives this observation.
            using var job = Native.OpenJobObjectW(0x0004, false, name);
            Native.Check(!job.IsInvalid, "OpenJobObjectW(test query)");
            Native.Check(Native.IsProcessInJob(handle, job, out bool belongs), "IsProcessInJob(test pin)");
            InOriginalJob = belongs;
            Require(belongs && Alive, "Transferred original process is not live in the original Job.");
        }

        public Task JoinAsync(CancellationToken cancellationToken) => Task.Run(() =>
        {
            using var wait = new BorrowedProcessWait(handle);
            if (WaitHandle.WaitAny([wait, cancellationToken.WaitHandle]) != 0) cancellationToken.ThrowIfCancellationRequested();
            Require(!Alive, "Original process join did not observe its native signal.");
        });

        public void Dispose() => handle.Dispose();
        private sealed class BorrowedProcessWait : WaitHandle
        {
            internal BorrowedProcessWait(SafeFileHandle process) => SafeWaitHandle = new SafeWaitHandle(process.DangerousGetHandle(), false);
        }
    }

    private static class Native
    {
        internal static void Check(bool success, string stage)
        {
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), stage);
        }

        internal static ProcessIdentity Identity(IntPtr process)
        {
            Check(GetProcessTimes(process, out long created, out _, out _, out _), "GetProcessTimes(test object)");
            uint pid = GetProcessId(process);
            Check(pid != 0, "GetProcessId(test object)");
            Require(created > 0, "Test process creation time is unavailable.");
            return new ProcessIdentity(checked((int)pid), unchecked((ulong)created));
        }

        internal static SafeFileHandle OpenDuplicateTarget(int pid, ulong creationTime)
        {
            var target = OpenProcess(0x0040 | 0x1000, false, pid);
            try
            {
                Check(!target.IsInvalid, "OpenProcess(test fixture duplicate target)");
                Require(Identity(target.DangerousGetHandle()) == new ProcessIdentity(pid, creationTime), "Original duplicate target identity changed.");
                return target;
            }
            catch { target.Dispose(); throw; }
        }

        internal static HandleProof DuplicateForHost(IntPtr original, SafeFileHandle host, string source)
        {
            var identity = Identity(original);
            Check(DuplicateHandle(new IntPtr(-1), original, host, out var transferred, 0, false, 2), "DuplicateHandle(original process to test fixture)");
            return new HandleProof(identity.Pid, identity.CreationFileTime.ToString(CultureInfo.InvariantCulture), transferred.ToInt64().ToString(CultureInfo.InvariantCulture), source);
        }

        internal static bool IsAlive(SafeFileHandle handle)
        {
            uint result = WaitForSingleObject(handle, 0);
            Check(result is 0 or 258, "WaitForSingleObject(test pin)");
            return result == 258;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, SafeFileHandle targetProcess,
            out IntPtr target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeFileHandle OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool belongs);
    }
}
