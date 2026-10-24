using Zeb.WindowsSupervisor;

namespace Zeb.WindowsServiceHost;

internal sealed record WorkerOutputObservation(long BytesRead, bool Eof, string? ReadFailureType, string? SinkFailureType);

internal sealed record WorkerCleanupObservation(
    ProcessRootExit? RootExit, JobTreeExit? TreeExit,
    WorkerOutputObservation Stdout, WorkerOutputObservation Stderr);

internal sealed record WorkerStartupSettlement(string? JobName, bool? Sealed, uint? OwnerReleasedTreeActive,
    int ForceCalls, string? FailureType, WorkerCleanupObservation Cleanup,
    int CleanupFailureCount, bool OwnerReleaseCompleted);

internal sealed record WorkerGracefulStopObservation(
    bool Selected, long? RequestedTick, long? DeadlineTick, int FrameWrites, bool FrameSent, long? FrameSentTick,
    bool HardPreempt, string? Failure, int ForceCalls, long? ForceTick, bool Verified,
    uint? OwnerReleasedTreeActive, bool WriteJoined);

public sealed class ContainedWorkerSession : IDisposable
{
    private readonly object sync = new();
    private readonly string executable, workingDirectory;
    private readonly string[] arguments;
    private readonly Action<ReadOnlyMemory<byte>> stdoutSink, stderrSink;
    private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource startupFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource hardPreempt = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static readonly byte[] ShutdownFrame = "ZEB_WORKER_SHUTDOWN_V1\n"u8.ToArray();
    private readonly List<Exception> failures = [];
    private JobProcess? job = null;
    private Task? cleanup = null;
    private Task<ProcessRootExit>? processWait;
    private Task<JobTreeExit>? treeWait;
    private Task? rootObserver, stdoutDrain, stderrDrain;
    private ProcessRootExit? rootExit = null;
    private Exception? rootExitTwoFailure;
    private JobTreeExit? treeExit = null;
    private WorkerOutputObservation stdout = new(0, false, null, null), stderr = new(0, false, null, null);
    private bool started = false, admissionSealed = false, stopRequested = false, disposed = false;
    private bool authorized, authorizationAttempted, gracefulSelected, gracefulVerified, frameSent, hardPreemptRequested, cleanupDecisionFinal;
    private long? gracefulRequestedTick, gracefulDeadlineTick, frameSentTick, forceTick;
    private int frameWrites, forceCalls;
    private uint? ownerReleasedTreeActive;
    private string? gracefulFailure;
    private Task? frameWriteTask, gracefulProofTask;
    private StartupObservation? startupObservation;
    private readonly TaskCompletionSource<WorkerStartupSettlement> startupCleanup = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Task? startupFinal;
    private bool? ownerReleasedSealed;
    private bool ownerReleaseCompleted;

    internal ContainedWorkerSession(string executable, IReadOnlyList<string> arguments, string workingDirectory,
        Action<ReadOnlyMemory<byte>> stdoutSink, Action<ReadOnlyMemory<byte>> stderrSink)
    {
        ArgumentException.ThrowIfNullOrEmpty(executable);
        ArgumentNullException.ThrowIfNull(arguments);
        ArgumentException.ThrowIfNullOrEmpty(workingDirectory);
        ArgumentNullException.ThrowIfNull(stdoutSink);
        ArgumentNullException.ThrowIfNull(stderrSink);
        if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(workingDirectory))
            throw new ArgumentException("Worker launch must be frozen to absolute local paths.");
        this.executable = Path.GetFullPath(executable);
        this.workingDirectory = Path.GetFullPath(workingDirectory);
        this.arguments = arguments.Select(value =>
        {
            ArgumentNullException.ThrowIfNull(value);
            if (value.Contains('\0')) throw new ArgumentException("Worker arguments cannot contain NUL.", nameof(arguments));
            return value;
        }).ToArray();
        this.stdoutSink = stdoutSink;
        this.stderrSink = stderrSink;
    }

    public Task Completion => completion.Task;
    public void Start() => Start(null);

    internal void Start(StartupObservation? observation)
    {
        lock (sync)
        {
            if (started || admissionSealed) throw new InvalidOperationException("The worker generation is already started or sealed.");
            started = true;
            startupObservation = observation;
        }
        try
        {
            var prepared = JobProcess.Prepare(executable,
                observation is null ? arguments : [.. arguments, observation.NodeArgument], workingDirectory);
            lock (sync) job = prepared;
            var root = prepared.WaitForProcessExitAsync();
            var tree = prepared.WaitForTreeExitAsync();
            lock (sync) { processWait = root; treeWait = tree; }
            var output = DrainAsync(prepared.StandardOutput, stdoutSink, isError: false);
            lock (sync) stdoutDrain = output;
            var error = DrainAsync(prepared.StandardError, stderrSink, isError: true);
            lock (sync) stderrDrain = error;
            var observer = ObserveRootAsync(root);
            lock (sync)
            {
                rootObserver = observer;
                if (admissionSealed) return;
                // This is the launch/stop admission boundary; native authorization never holds sync.
            }
            if (observation is not null)
            {
                observation.BeforeAuthorize(prepared, executable);
                lock (sync)
                {
                    if (admissionSealed) return;
                    observation.RequireAuthorizationWindow();
                    // A fast original exit may race the post-Resume authorized assignment.
                    authorizationAttempted = true;
                }
            }
            if (!prepared.AuthorizeOnce()) throw new InvalidOperationException("The worker generation could not be authorized.");
            lock (sync) authorized = true;
            observation?.PublishAuthorized(prepared);
            if (observation is not null)
            {
                var final = observation.ObserveFinalAsync(startupCleanup.Task);
                lock (sync) startupFinal = final;
            }
        }
        catch (Exception failure)
        {
            observation?.RecordFailure(failure);
            bool contain;
            lock (sync) contain = observation is null || !authorized;
            // Losing observation after Resume is not authority to kill a possibly recovering worker.
            if (contain) _ = RequestCleanup(failure);
            throw;
        }
        finally { startupFinished.TrySetResult(); }
    }

    public Task StopAsync() => RequestCleanup(stop: true);
    public Task GracefulStopAsync() => RequestCleanup(graceful: true);

    private Task RequestCleanup(Exception? failure = null, bool stop = false, bool graceful = false)
    {
        bool begin;
        Task result;
        StartupObservation? cancelObservation;
        lock (sync)
        {
            if (cleanupDecisionFinal) return cleanup ?? completion.Task;
            if (graceful && cleanup is not null) return cleanup;
            if (failure is not null) AddFailure(failure);
            if (graceful && cleanup is null)
            {
                CaptureCompletedRoot();
                if (failures.Count == 0)
                {
                    gracefulSelected = true;
                    gracefulRequestedTick = Environment.TickCount64;
                    gracefulDeadlineTick = checked(gracefulRequestedTick.Value + 30_000);
                }
            }
            if (stop)
            {
                CaptureCompletedRoot();
                stopRequested = true;
            }
            if (!graceful || !gracefulSelected)
            {
                hardPreemptRequested = true;
                if (gracefulSelected)
                    FailGracefulLocked(failure is null ? "hard_preempt" : "hard_fault",
                        new InvalidOperationException("The worker cooperative stop was preempted."));
                hardPreempt.TrySetResult();
            }
            // Seal the original native gate before exposing the observed stop decision.
            if (startupObservation is not null && !authorized) job?.Seal();
            admissionSealed = true;
            cancelObservation = !authorizationAttempted || stop || graceful ? startupObservation : null;
            begin = cleanup is null;
            result = cleanup ??= completion.Task;
            if (!started) startupFinished.TrySetResult();
        }
        try { cancelObservation?.CancelPending(); }
        catch (Exception cancelFailure) { lock (sync) AddFailure(cancelFailure); }
        if (begin) _ = CleanupAsync();
        return result;
    }

    private async Task ObserveRootAsync(Task<ProcessRootExit> wait)
    {
        try
        {
            var actual = await wait.ConfigureAwait(false);
            lock (sync)
            {
                if (!disposed) SaveRoot(actual);
                // Never await the cleanup whose coordinator joins this observer.
                if (gracefulSelected && actual.ExitCode == 0 && !hardPreemptRequested) return;
            }
            _ = RequestCleanup();
        }
        catch (Exception failure) { _ = RequestCleanup(failure); }
    }

    private async Task DrainAsync(Stream stream, Action<ReadOnlyMemory<byte>> sink, bool isError)
    {
        byte[] buffer = new byte[16 * 1024];
        long bytesRead = 0;
        bool eof = false;
        string? readFailure = null, sinkFailure = null;
        try
        {
            while (true)
            {
                int count;
                try { count = await stream.ReadAsync(buffer.AsMemory()).ConfigureAwait(false); }
                catch (Exception failure)
                {
                    readFailure = failure.GetType().Name;
                    _ = RequestCleanup(failure);
                    break;
                }
                if (count == 0) { eof = true; break; }
                bytesRead += count;
                if (isError) startupObservation?.ObserveStderr(buffer.AsSpan(0, count));
                if (sinkFailure is not null) continue;
                try { sink(buffer.AsMemory(0, count)); }
                catch (Exception failure)
                {
                    sinkFailure = failure.GetType().Name;
                    _ = RequestCleanup(failure);
                }
            }
        }
        finally
        {
            var actual = new WorkerOutputObservation(bytesRead, eof, readFailure, sinkFailure);
            lock (sync) { if (isError) stderr = actual; else stdout = actual; }
            if (isError) startupObservation?.CompleteStderr();
        }
    }

    private async Task CleanupAsync()
    {
        await startupFinished.Task.ConfigureAwait(false);
        JobProcess? owner;
        Task<ProcessRootExit>? root;
        Task<JobTreeExit>? tree;
        Task? observer, output, error;
        lock (sync)
        {
            owner = job; root = processWait; tree = treeWait;
            observer = rootObserver; output = stdoutDrain; error = stderrDrain;
        }
        try
        {
            if (owner is not null)
            {
                try
                {
                    bool cooperative = await TryGracefulStopAsync(owner, root, tree, observer, output, error).ConfigureAwait(false);
                    if (!cooperative)
                    {
                        lock (sync) { forceCalls++; forceTick = Environment.TickCount64; }
                        // Exactly this original owner remains the immediate fault/timeout containment authority.
                        owner.Force();
                    }
                    if (root is not null)
                    {
                        var actual = await root.ConfigureAwait(false);
                        lock (sync) SaveRoot(actual);
                    }
                    if (tree is not null)
                    {
                        var actual = await tree.ConfigureAwait(false);
                        lock (sync) treeExit = actual;
                    }
                }
                catch (Exception failure)
                {
                    lock (sync) AddFailure(failure);
                    // Closing the exact owner contains failure; it does not supply missing exit or EOF proof.
                    ReleaseOwner(owner);
                }
            }
            await JoinAsync(observer).ConfigureAwait(false);
            await JoinAsync(root).ConfigureAwait(false);
            await JoinAsync(tree).ConfigureAwait(false);
            await JoinAsync(output).ConfigureAwait(false);
            await JoinAsync(error).ConfigureAwait(false);
            await JoinAsync(frameWriteTask).ConfigureAwait(false);
            await JoinAsync(gracefulProofTask).ConfigureAwait(false);
        }
        catch (Exception failure) { lock (sync) AddFailure(failure); }
        finally
        {
            if (owner is not null) ReleaseOwner(owner);
            Exception[] errors;
            int cleanupFailureCount;
            bool releaseCompleted;
            lock (sync)
            {
                cleanupDecisionFinal = true; errors = failures.ToArray();
                // Keep the original exit2 business error; only its exact reference is not a cleanup fault.
                cleanupFailureCount = errors.Count(failure => rootExit?.ExitCode != 2 || !ReferenceEquals(failure, rootExitTwoFailure));
                releaseCompleted = ownerReleaseCompleted;
            }
            startupCleanup.TrySetResult(new(owner?.JobName, ownerReleasedSealed, ownerReleasedTreeActive, forceCalls,
                errors.FirstOrDefault()?.GetType().Name, CleanupObservation, cleanupFailureCount, releaseCompleted));
            // The final observer consumes physical cleanup; it never controls this worker's outcome.
            if (startupFinal is not null) await startupFinal.ConfigureAwait(false);
            if (errors.Length == 0) completion.TrySetResult();
            else completion.TrySetException(errors);
        }
    }


    private async Task<bool> TryGracefulStopAsync(JobProcess owner, Task<ProcessRootExit>? root,
        Task<JobTreeExit>? tree, Task? observer, Task? output, Task? error)
    {
        long deadline;
        lock (sync)
        {
            if (!gracefulSelected) return false;
            if (hardPreemptRequested) return false;
            deadline = gracefulDeadlineTick!.Value;
            if (Environment.TickCount64 >= deadline)
            {
                FailGracefulLocked("deadline", new TimeoutException("The worker cooperative stop deadline elapsed."));
                return false;
            }
            if (!authorized || root is null || tree is null || observer is null || output is null || error is null)
            {
                FailGracefulLocked("startup_unavailable", new InvalidOperationException("The original worker was not authorized for cooperative stop."));
                return false;
            }
        }
        using var writeDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(1, deadline - Environment.TickCount64)));
        CancellationToken writeToken = writeDeadline.Token;
        Task write;
        lock (sync)
        {
            if (hardPreemptRequested) return false;
            if (Environment.TickCount64 >= deadline)
            {
                FailGracefulLocked("deadline", new TimeoutException("The worker cooperative stop deadline elapsed."));
                return false;
            }
            // The original synchronous anonymous pipe must never block the coordinator or hold sync.
            write = frameWriteTask ??= Task.Run(() => WriteShutdownFrameAsync(owner, writeToken));
        }
        Task proof = Task.WhenAll(write, root!, tree!, observer!, output!, error!);
        lock (sync) gracefulProofTask = proof;
        while (!proof.IsCompleted)
        {
            long remaining = deadline - Environment.TickCount64;
            if (remaining <= 0 || hardPreempt.Task.IsCompleted) break;
            using var delay = new CancellationTokenSource();
            try { await Task.WhenAny(proof, hardPreempt.Task, Task.Delay(TimeSpan.FromMilliseconds(remaining), delay.Token)).ConfigureAwait(false); }
            finally { delay.Cancel(); }
        }
        if (proof.IsCompleted)
        {
            try { await proof.ConfigureAwait(false); }
            catch (Exception failure)
            {
                lock (sync) FailGracefulLocked("proof_failed", failure);
            }
        }
        lock (sync)
        {
            if (root!.IsCompletedSuccessfully) SaveRoot(root.Result);
            if (tree!.IsCompletedSuccessfully) treeExit = tree.Result;
            if (proof.IsCompletedSuccessfully && frameSent && rootExit?.ExitCode == 0 && treeExit?.ActiveProcesses == 0 &&
                stdout.Eof && stderr.Eof && stdout.ReadFailureType is null && stderr.ReadFailureType is null &&
                stdout.SinkFailureType is null && stderr.SinkFailureType is null && failures.Count == 0 &&
                !hardPreemptRequested && Environment.TickCount64 < deadline)
            {
                gracefulVerified = true;
                cleanupDecisionFinal = true;
                return true;
            }
            FailGracefulLocked(Environment.TickCount64 >= deadline ? "deadline" : "proof_failed",
                new InvalidOperationException("The worker cooperative stop was not verified."));
        }
        writeDeadline.Cancel();
        return false;
    }

    private async Task WriteShutdownFrameAsync(JobProcess owner, CancellationToken token)
    {
        try
        {
            lock (sync)
            {
                if (hardPreemptRequested || Environment.TickCount64 >= gracefulDeadlineTick!.Value)
                    throw new OperationCanceledException("The original cooperative frame window ended.", token);
            }
            Stream originalInput = owner.StandardInput;
            lock (sync) frameWrites++;
            await originalInput.WriteAsync(ShutdownFrame, token).ConfigureAwait(false);
            await originalInput.FlushAsync(token).ConfigureAwait(false);
            lock (sync) { frameSent = true; frameSentTick = Environment.TickCount64; }
        }
        catch (Exception failure)
        {
            lock (sync) FailGracefulLocked(Environment.TickCount64 >= gracefulDeadlineTick!.Value ? "deadline" : "frame_write", failure);
            _ = RequestCleanup(failure);
            throw;
        }
    }

    private void FailGracefulLocked(string code, Exception failure)
    {
        gracefulFailure ??= code;
        AddFailure(failure);
    }

    private async Task JoinAsync(Task? task)
    {
        if (task is null) return;
        try { await task.ConfigureAwait(false); }
        catch (Exception failure) { lock (sync) AddFailure(failure); }
    }

    private void ReleaseOwner(JobProcess owner)
    {
        lock (sync)
        {
            if (disposed) return;
            CaptureCompletedRoot();
            if (treeWait?.IsCompletedSuccessfully == true) treeExit = treeWait.Result;
            ownerReleasedTreeActive = treeExit?.ActiveProcesses;
            if (startupObservation is not null)
            {
                try { ownerReleasedSealed = owner.Inspect().Sealed; }
                catch (Exception failure) { AddFailure(failure); }
            }
            disposed = true;
        }
        try
        {
            owner.Dispose();
            lock (sync) ownerReleaseCompleted = true;
        }
        catch (Exception failure) { lock (sync) AddFailure(failure); }
    }

    private void CaptureCompletedRoot()
    {
        if (!disposed && processWait?.IsCompletedSuccessfully == true) SaveRoot(processWait.Result);
    }

    private void SaveRoot(ProcessRootExit actual)
    {
        if (rootExit is not null) return;
        rootExit = actual;
        if (actual.ExitCode != 0 && !stopRequested)
        {
            if (gracefulSelected) gracefulFailure ??= "worker_nonzero";
            var failure = new InvalidOperationException("The worker root exited unsuccessfully.");
            if (actual.ExitCode == 2) rootExitTwoFailure = failure;
            AddFailure(failure);
        }
    }

    private void AddFailure(Exception failure)
    {
        if (!failures.Contains(failure)) failures.Add(failure);
    }

    internal string? JobName { get { lock (sync) return job?.JobName; } }
    internal JobProcessObservation? Inspect()
    {
        lock (sync)
        {
            if (job is null) return null;
            ObjectDisposedException.ThrowIf(disposed, this);
            return job.Inspect();
        }
    }
    internal WorkerCleanupObservation CleanupObservation
    {
        get { lock (sync) return new(rootExit, treeExit, stdout, stderr); }
    }
    internal WorkerGracefulStopObservation GracefulObservation
    {
        get
        {
            lock (sync) return new(gracefulSelected, gracefulRequestedTick, gracefulDeadlineTick, frameWrites, frameSent, frameSentTick,
                hardPreemptRequested, gracefulFailure, forceCalls, forceTick, gracefulVerified, ownerReleasedTreeActive,
                frameWriteTask?.IsCompleted ?? true);
        }
    }

    // The trusted fixture forwards bytes and closes this exact stdin only after its caller's actual EOF.
    internal Stream StandardInput
    {
        get
        {
            lock (sync)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                return job?.StandardInput ?? throw new InvalidOperationException("Worker has not started.");
            }
        }
    }

    public void Dispose()
    {
        try { StopAsync().GetAwaiter().GetResult(); }
        // Completion retains every worker/cleanup failure; Dispose only joins that same cleanup.
        catch (Exception) when (completion.Task.IsFaulted) { }
    }
}
