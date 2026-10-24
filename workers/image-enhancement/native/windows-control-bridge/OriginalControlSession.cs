using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsControlBridge;

internal sealed class OriginalControlSession
{
    private sealed record ExitObservation(bool Proved, uint Code);
    private sealed class Operation(string id, string op, long? requestAnchor, BridgeCommand? command = null)
    {
        internal string Id { get; } = id;
        internal string Op { get; } = op;
        internal long? RequestAnchor { get; } = requestAnchor;
        internal TaskCompletionSource<JsonElement?> Response { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Task<bool> Write { get; set; } = Task.FromResult(false);
        internal BridgeCommand? Command { get; } = command;
        internal TaskCompletionSource<bool> Permit { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal bool PermitRequested { get; set; }
        internal bool PermitReceived { get; set; }
        internal bool WriteInvoked { get; set; }
    }
    private sealed class OriginalChannel(NamedPipeClientStream pipe, string role)
    {
        internal NamedPipeClientStream Pipe { get; } = pipe;
        internal string Role { get; } = role;
        internal SemaphoreSlim Writer { get; } = new(1, 1);
        internal Dictionary<string, Operation> Pending { get; } = new(StringComparer.Ordinal);
        internal Task<FrameJoin>? Reader { get; set; }
        internal bool LocallyClosing { get; set; }
        internal bool Watched { get; set; }
    }

    private readonly object gate = new();
    private readonly BridgeConfiguration configuration;
    private readonly BridgeLimits limits;
    private readonly CancellationTokenSource admissionCancellation = new(), pipeCancellation = new();
    private readonly TaskCompletionSource<bool> sealedSession = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<string> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<bool> retainedOwner = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly HashSet<string> callerIds = new(StringComparer.Ordinal), nativeIds = new(StringComparer.Ordinal);
    private readonly List<Task<bool>> writes = [];
    private readonly List<Task> inspections = [];
    private OriginalProcessPin? self, helper;
    private Process? originalProcess;
    private NamedPipeClientStream? ownerPipe, observerPipe;
    private OriginalChannel? owner, observer;
    private Task<FrameJoin>? helperOutput, input;
    private Task<bool>? helperError;
    private Task<ExitObservation>? helperExit;
    private Task? startup;
    private BoundedOutputWriter? output;
    private MonotonicDeadline? startupDeadline, sessionDeadline, cleanupDeadline;
    private BridgeCommand? inspect;
    private long inspectAnchor;
    private BridgeCommand? executionCommand;
    private Operation? executionOperation;
    private BridgeCommand? softCommand, forceCommand;
    private Operation? softOperation, forceOperation;
    private long softAnchor, forceAnchor;
    private bool softSettled, forceSettled, authorizeSucceeded;
    private PreparePayload? preparePayload;
    private bool runtimeRequested;
    private BootBackgroundObservation? runtimeBackground;
    private JsonElement? preparedDescriptor;
    private Task<bool>? endingWrite;
    private Operation? stop;
    private string? executionId, closeRequestId;
    private bool startAttempted, startSucceeded, bound, readySeen, isSealed, acceptedClose;
    private bool inputEof, unknown, unknownAttempted, cleanupExpired, forceAttempted, forceConsidered;
    private bool channelsDisposed, gateH, stopWritten, stopReplied;
    private bool prepareAccepted, authorizeAccepted, naturalEnding, endingAttempted;
    private long launchAnchor, cleanupAnchor;

    internal OriginalControlSession(BridgeConfiguration configuration)
    {
        this.configuration = configuration;
        limits = configuration.Limits;
    }

    internal async Task<int> RunAsync()
    {
        try
        {
            long anchor = Stopwatch.GetTimestamp();
            launchAnchor = anchor;
            output = new(Console.OpenStandardOutput(), limits, Fault);
            startupDeadline = new(anchor, limits.StartupTimeoutMs, ObservationExpired);
            sessionDeadline = new(anchor, limits.SessionTimeoutMs, ObservationExpired);
            input = Task.Run(ReadInputAsync);
            try { self = OriginalProcessPin.Current(); }
            catch { Fault(); }
            startup = Task.Run(StartAndBindAsync);
            await sealedSession.Task;
            await startup;
            await CleanupHelperAndInputAsync();
            if (runtimeBackground is not null && !runtimeBackground.RevalidateForClose()) Fault();

            Task<bool>? terminal;
            bool stopped;
            lock (gate)
            {
                // Gate H precedes this writer's terminal frame. It never
                // includes the stdout writer that must deliver that frame.
                gateH = true;
                cleanupDeadline?.Cancel();
                stopped = (acceptedClose || naturalEnding) && !unknown && !forceAttempted &&
                    helperExit is { IsCompletedSuccessfully: true } && helperExit.Result.Code == 0 &&
                    (prepareAccepted ? endingWrite is { IsCompletedSuccessfully: true } && endingWrite.Result : stopWritten || stopReplied);
                if (!stopped) unknown = true;
                terminal = output.Enqueue(BridgeProtocol.Closed(closeRequestId, executionId, stopped));
                if (terminal is null) unknown = true;
                output.Seal();
            }
            // Gate B: actual terminal write/flush, the one writer, timers and
            // all original tasks join. A blocked writer keeps this owner alive.
            bool delivered = terminal is not null && await terminal;
            await output.Completion;
            await startupDeadline.DisposeAsync();
            await sessionDeadline.DisposeAsync();
            if (cleanupDeadline is not null) await cleanupDeadline.DisposeAsync();
            runtimeBackground?.Dispose();
            helper?.Dispose();
            originalProcess?.Dispose();
            self?.Dispose();
            owner?.Writer.Dispose(); observer?.Writer.Dispose();
            admissionCancellation.Dispose(); pipeCancellation.Dispose();
            return stopped && delivered && !output.Failed ? 0 : 2;
        }
        catch
        {
            // Unexpected failure has no release proof. Keep the same owner,
            // original pins and admission barrier; never exit to satisfy time.
            Fault();
            await retainedOwner.Task;
            GC.KeepAlive(this);
            return 2;
        }
    }

    private async Task StartAndBindAsync()
    {
        try
        {
            string leaf = "zeb-control-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            lock (gate)
            {
                if (!OpenAtBoundaryLocked() || self is null) return;
                self.RequireIdentity();
                if (self.IsSignaled()) throw new InvalidDataException();
                var launch = new ProcessStartInfo(configuration.HelperPath)
                {
                    UseShellExecute = false, CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(configuration.HelperPath)!,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                };
                launch.Environment.Clear();
                foreach (var value in configuration.Environment) launch.Environment.Add(value.Key, value.Value);
                foreach (string value in new[]
                {
                    "--pipe", leaf, "--controller-pid", self.Pid.ToString(CultureInfo.InvariantCulture),
                    "--records-root", configuration.RecordsRoot, "--installation-root", configuration.InstallationRoot,
                    "--expected-manifest-sha256", configuration.ExpectedManifestSha256,
                }) launch.ArgumentList.Add(value);
                originalProcess = new Process { StartInfo = launch };
                startAttempted = true;
                if (!originalProcess.Start()) throw new InvalidDataException();
                startSucceeded = true;
                // Duplicate immediately from the exact successful Start object.
                helper = OriginalProcessPin.FromSuccessfulStart(originalProcess);
                StartOriginalObservationsLocked();
                if (!helper.User.Equals(self.User) || helper.IsSignaled()) throw new InvalidDataException();
                originalProcess.StandardInput.Close();
            }
            string execution = await ready.Task.WaitAsync(admissionCancellation.Token);
            await ConnectOwnerAsync(leaf);
            Operation claim;
            lock (gate) claim = BeginOperationLocked(owner!, "claim", null);
            if (!await claim.Write || await claim.Response.Task.WaitAsync(admissionCancellation.Token) is not JsonElement claimed ||
                claimed.GetProperty("phase").GetString() != "claimed" || claimed.GetProperty("sealReason").ValueKind != JsonValueKind.Null)
                throw new InvalidDataException();
            await ConnectObserverAsync(leaf);
            Operation watch;
            lock (gate) watch = BeginOperationLocked(observer!, "watch", null);
            if (!await watch.Write || await watch.Response.Task.WaitAsync(admissionCancellation.Token) is not JsonElement state ||
                state.GetProperty("phase").GetString() != "claimed" || state.GetProperty("sealReason").ValueKind != JsonValueKind.Null)
                throw new InvalidDataException();
            lock (gate)
            {
                if (!OpenAtBoundaryLocked() || inputEof || admissionCancellation.IsCancellationRequested) return;
                self!.RequireIdentity(); helper!.RequireIdentity();
                if (helper.IsSignaled()) throw new InvalidDataException();
                if (executionId != execution || !observer!.Watched) throw new InvalidDataException();
                if (!OpenAtBoundaryLocked()) return;
                if (!output!.PublishBound(BridgeProtocol.Bound(execution, self, helper, state)))
                {
                    FaultLocked(); return;
                }
                bound = true;
                startupDeadline!.Cancel();
            }
        }
        catch (OperationCanceledException) when (admissionCancellation.IsCancellationRequested) { }
        catch
        {
            lock (gate)
            {
                // Even a failed pin adoption retains the successfully created
                // Process/streams. They cannot establish Gate H without a pin.
                if (startSucceeded) StartOriginalObservationsLocked();
                FaultLocked();
            }
        }
    }

    private void StartOriginalObservationsLocked()
    {
        if (originalProcess is null || !startSucceeded) return;
        if (helperOutput is null)
        {
            Stream originalOutput = originalProcess.StandardOutput.BaseStream;
            helperOutput = Task.Run(() => ReadHelperOutputAsync(originalOutput));
        }
        if (helperError is null)
        {
            Stream originalError = originalProcess.StandardError.BaseStream;
            helperError = Task.Run(() => ReadHelperErrorAsync(originalError));
        }
        if (helper is not null && helperExit is null)
        {
            OriginalProcessPin original = helper;
            helperExit = Task.Run(() => ObserveHelperExitAsync(original));
        }
    }

    private async Task ConnectOwnerAsync(string leaf)
    {
        NamedPipeClientStream pipe;
        lock (gate)
        {
            if (!OpenAtBoundaryLocked()) throw new OperationCanceledException(admissionCancellation.Token);
            ownerPipe = pipe = NewPipe(leaf);
        }
        await pipe.ConnectAsync(admissionCancellation.Token);
        lock (gate)
        {
            if (!OpenAtBoundaryLocked()) throw new OperationCanceledException(admissionCancellation.Token);
            helper!.VerifyPeer(pipe.SafePipeHandle);
            owner = new(pipe, "owner");
            OriginalChannel original = owner;
            original.Reader = Task.Run(() => ReadNativeAsync(original));
        }
    }

    private async Task ConnectObserverAsync(string leaf)
    {
        NamedPipeClientStream pipe;
        lock (gate)
        {
            if (!OpenAtBoundaryLocked()) throw new OperationCanceledException(admissionCancellation.Token);
            observerPipe = pipe = NewPipe(leaf);
        }
        await pipe.ConnectAsync(admissionCancellation.Token);
        lock (gate)
        {
            if (!OpenAtBoundaryLocked()) throw new OperationCanceledException(admissionCancellation.Token);
            helper!.VerifyPeer(pipe.SafePipeHandle);
            observer = new(pipe, "observer");
            OriginalChannel original = observer;
            original.Reader = Task.Run(() => ReadNativeAsync(original));
        }
    }

    private static NamedPipeClientStream NewPipe(string leaf) => new(".", leaf, PipeDirection.InOut,
        PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);

    private async Task<FrameJoin> ReadHelperOutputAsync(Stream stream)
    {
        FrameJoin result = await BoundedFrameReader.ReadAsync(stream, limits.MaxResponseFrameBytes, null, true,
            bytes =>
            {
                string execution = BridgeProtocol.Ready(bytes, limits.MaxJsonDepth);
                lock (gate)
                {
                    if (readySeen) throw new InvalidDataException();
                    readySeen = true;
                    executionId = execution;
                    ready.TrySetResult(execution);
                }
            }, Fault, CancellationToken.None, () => false);
        if (result == FrameJoin.Eof) await ReconcilePendingPrepareReplyAsync();
        lock (gate)
        {
            if (!readySeen || result != FrameJoin.Eof) FaultLocked();
            else if (prepareAccepted) BeginNaturalLocked();
            else if (!isSealed) FaultLocked();
        }
        return result;
    }

    private async Task<bool> ReadHelperErrorAsync(Stream stream)
    {
        byte[] bytes = new byte[Math.Min(4096, limits.MaxHelperStderrBytes)];
        long observed = 0;
        try
        {
            while (true)
            {
                int read = await stream.ReadAsync(bytes);
                if (read == 0) return true;
                observed = Math.Min((long)limits.MaxHelperStderrBytes + 1, observed + read);
                // Every stderr byte is an error; retain none, including floods.
                Fault();
            }
        }
        catch { Fault(); return false; }
    }

    private async Task<ExitObservation> ObserveHelperExitAsync(OriginalProcessPin original)
    {
        try
        {
            uint code = await original.WaitForExitAsync();
            await ReconcilePendingPrepareReplyAsync();
            lock (gate)
            {
                if (prepareAccepted) BeginNaturalLocked();
                else if (!isSealed) FaultLocked();
                if (code != 0) FaultLocked();
            }
            return new(true, code);
        }
        catch { Fault(); return new(false, 0); }
    }

    private async Task<FrameJoin> ReadInputAsync()
    {
        FrameJoin joined = await BoundedFrameReader.ReadAsync(Console.OpenStandardInput(), limits.MaxRequestFrameBytes,
            limits.MaxSessionInputBytes, false, AcceptCommand, Fault, CancellationToken.None, () => false);
        lock (gate)
        {
            if (joined == FrameJoin.Eof)
            {
                inputEof = true;
                // A valid close has priority over its following real EOF. That
                // EOF joins input, and does not cancel the original stop write.
                if (!acceptedClose && !isSealed) FaultLocked();
            }
            else FaultLocked();
        }
        return joined;
    }

    private void AcceptCommand(ReadOnlyMemory<byte> bytes)
    {
        BridgeCommand command = BridgeProtocol.Command(bytes, limits.MaxJsonDepth);
        lock (gate)
        {
            if (!bound || command.ExecutionId != executionId)
                throw new InvalidDataException();
            if (command.IsPermit)
            {
                Operation? pending = owner!.Pending.GetValueOrDefault(command.RequestId);
                if (pending is null || pending.Id != command.RequestId || pending.Op != command.Op ||
                    pending.Command?.RequestFingerprint != command.RequestFingerprint || !pending.PermitRequested || pending.PermitReceived)
                    throw new InvalidDataException();
                pending.PermitReceived = true;
                if (isSealed || pending.Command is null || !CommandCurrentLocked(pending.Command)) throw new InvalidDataException();
                pending.Permit.TrySetResult(command.Allow is true);
                return;
            }
            if (!callerIds.Add(command.RequestId)) throw new InvalidDataException();
            if (naturalEnding && command.Op == "close")
            {
                if (acceptedClose) throw new InvalidDataException();
                acceptedClose = true; closeRequestId = command.RequestId;
                return; // ID acknowledgment only; the natural cleanup is already in progress.
            }
            if (!OpenAtBoundaryLocked()) return; // No forwarding, queue or renewed deadline.
            if (command.Op == "close")
            {
                acceptedClose = true;
                closeRequestId = command.RequestId;
                SealLocked();
                return;
            }
            if (command.Op == "request-stop")
            {
                if (!authorizeSucceeded || executionCommand is not null || preparedDescriptor is null || preparePayload is null || command.Payload is not JsonElement payload ||
                    !JsonElement.DeepEquals(payload.GetProperty("descriptor"), preparedDescriptor.Value) || command.RequestFingerprint != preparePayload.RequestFingerprint) throw new InvalidDataException();
                long start = payload.GetProperty("stopRequestedAt").GetInt64(), end = payload.GetProperty("terminateAfterAt").GetInt64();
                if (checked(end - start) != preparePayload.Limits.CancelGraceMs) throw new InvalidDataException();
                BridgeCommand? first = softCommand ?? forceCommand;
                if (first?.Payload is JsonElement original && (original.GetProperty("stopRequestedAt").GetInt64() != start || original.GetProperty("terminateAfterAt").GetInt64() != end)) throw new InvalidDataException();
                long stopAnchor = Stopwatch.GetTimestamp();
                if (payload.GetProperty("mode").GetString() == "soft")
                { if (softCommand is not null) throw new InvalidDataException(); softCommand = command; softAnchor = stopAnchor; }
                else { if (forceCommand is not null) throw new InvalidDataException(); forceCommand = command; forceAnchor = stopAnchor; }
                inspections.Add(Task.Run(() => ExecuteAsync(command, stopAnchor)));
                return;
            }
            if (inspect is not null || executionCommand is not null) throw new InvalidDataException();
            if (command.Op is "prepare" or "authorize")
            {
                if (command.Op == "prepare")
                {
                    if (prepareAccepted || command.Prepare is null) throw new InvalidDataException();
                    // Admission can create a tree even when its ACK is lost. Never restore helper force.
                    prepareAccepted = true;
                    preparePayload = command.Prepare;
                    runtimeRequested = command.ObserveRuntime;
                }
                else
                {
                    if (authorizeAccepted || preparedDescriptor is null || command.Payload is not JsonElement payload ||
                        !JsonElement.DeepEquals(payload.GetProperty("descriptor"), preparedDescriptor.Value)) throw new InvalidDataException();
                    authorizeAccepted = true;
                }
                executionCommand = command;
                long executionAnchor = Stopwatch.GetTimestamp();
                inspections.Add(Task.Run(() => ExecuteAsync(command, executionAnchor)));
                return;
            }
            inspect = command;
            long anchor = Stopwatch.GetTimestamp();
            inspectAnchor = anchor;
            inspections.Add(Task.Run(() => InspectAsync(command, anchor)));
        }
    }

    private async Task ExecuteAsync(BridgeCommand command, long anchor)
    {
        await using var deadline = new MonotonicDeadline(anchor, limits.RequestTimeoutMs, () =>
        {
            lock (gate) if (CommandCurrentLocked(command) && !CommandSettledLocked(command) && !isSealed) FaultLocked();
        });
        try
        {
            if (command.Op == "prepare" && command.ObserveRuntime)
            {
                BootBackgroundObservation original;
                lock (gate)
                {
                    if (!OpenAtBoundaryLocked() || !CommandCurrentLocked(command)) return;
                    if (runtimeBackground is not null || self is null) throw new InvalidDataException();
                    runtimeBackground = original = new BootBackgroundObservation(self);
                }
                // Any slow OS identity lookup remains part of this original operation's join.
                original.Capture();
            }
            Operation request;
            lock (gate)
            {
                if (isSealed || !CommandCurrentLocked(command)) return;
                request = BeginOperationLocked(owner!, command.Op, anchor, command);
            }
            if (!await request.Write) return;
            JsonElement? response = await request.Response.Task.WaitAsync(admissionCancellation.Token);
            lock (gate)
            {
                if (!OpenAtBoundaryLocked() || !CommandCurrentLocked(command) || response is null) return;
                if (Stopwatch.GetElapsedTime(anchor).TotalMilliseconds >= limits.RequestTimeoutMs) { FaultLocked(); return; }
                ValidateExecutionStateLocked(response.Value);
                JsonElement state = response.Value;
                if (command.Op == "prepare")
                {
                    if (state.GetProperty("phase").GetString() != "prepared" || state.GetProperty("descriptor").ValueKind != JsonValueKind.Object)
                        throw new InvalidDataException();
                    preparedDescriptor = state.GetProperty("descriptor").Clone();
                }
                else if (!state.GetProperty("authorizationVerified").GetBoolean() || state.GetProperty("resumeState").GetString() != "succeeded")
                    throw new InvalidDataException();
                if (command.Op == "request-stop")
                {
                    string? reason = state.GetProperty("sealReason").GetString();
                    if (state.GetProperty("phase").GetString() != "sealed" || reason is not ("stop" or "deadline" or "controller_exit" or "controller_eof" or "control_write_failure")) throw new InvalidDataException();
                    if (ReferenceEquals(softCommand, command)) softSettled = true; else forceSettled = true;
                }
                else if (command.Op == "authorize") authorizeSucceeded = true;
                deadline.Cancel();
                // The ACK may immediately admit the next phase on another thread.
                if (ReferenceEquals(executionCommand, command)) { executionCommand = null; executionOperation = null; }
                if (output!.Enqueue(BridgeProtocol.State(command.RequestId, executionId!, state)) is null) FaultLocked();
                else RecordRuntimePublicationLocked(state);
            }
        }
        catch (OperationCanceledException) when (admissionCancellation.IsCancellationRequested) { }
        catch { Fault(); }
        finally
        {
            lock (gate)
            {
                if (ReferenceEquals(executionCommand, command)) executionCommand = null;
                if (ReferenceEquals(executionOperation?.Command, command)) executionOperation?.Permit.TrySetResult(false);
                if (ReferenceEquals(softOperation?.Command, command)) softOperation?.Permit.TrySetResult(false);
                if (ReferenceEquals(forceOperation?.Command, command)) forceOperation?.Permit.TrySetResult(false);
            }
        }
    }

    private async Task InspectAsync(BridgeCommand command, long anchor)
    {
        await using var deadline = new MonotonicDeadline(anchor, limits.RequestTimeoutMs, () =>
        {
            lock (gate) if (ReferenceEquals(inspect, command) && !isSealed) FaultLocked();
        });
        try
        {
            Operation request;
            lock (gate)
            {
                if (isSealed || !ReferenceEquals(inspect, command)) return;
                request = BeginOperationLocked(owner!, "inspect", anchor);
            }
            if (!await request.Write) return;
            JsonElement? state = await request.Response.Task.WaitAsync(admissionCancellation.Token);
            lock (gate)
            {
                if (!OpenAtBoundaryLocked() || !ReferenceEquals(inspect, command) || state is null) return;
                if (Stopwatch.GetElapsedTime(anchor).TotalMilliseconds >= limits.RequestTimeoutMs)
                {
                    FaultLocked(); return;
                }
                deadline.Cancel();
                inspect = null;
                if (output!.Enqueue(BridgeProtocol.State(command.RequestId, executionId!, state.Value)) is null)
                    FaultLocked();
                else RecordRuntimePublicationLocked(state.Value);
            }
        }
        catch (OperationCanceledException) when (admissionCancellation.IsCancellationRequested) { }
        catch { Fault(); }
        finally { lock (gate) if (ReferenceEquals(inspect, command)) inspect = null; }
    }

    private Operation BeginOperationLocked(OriginalChannel channel, string op, long? requestAnchor, BridgeCommand? command = null)
    {
        if (executionId is null || channelsDisposed || channel.LocallyClosing ||
            (op == "stop" ? !isSealed || !acceptedClose || stop is not null || cleanupExpired : isSealed))
            throw new InvalidDataException();
        string id = command?.RequestId ?? Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        if (!nativeIds.Add(id)) throw new InvalidDataException();
        var request = new Operation(id, op, requestAnchor, command);
        channel.Pending.Add(id, request);
        if (op == "stop") stop = request;
        if (command is not null)
        {
            if (ReferenceEquals(command, softCommand)) softOperation = request;
            else if (ReferenceEquals(command, forceCommand)) forceOperation = request;
            else executionOperation = request;
        }
        request.Write = WriteNativeAsync(channel, request);
        writes.Add(request.Write);
        return request;
    }

    private async Task<bool> WriteNativeAsync(OriginalChannel channel, Operation request)
    {
        bool acquired = false, invoked = false;
        try
        {
            await channel.Writer.WaitAsync(pipeCancellation.Token);
            acquired = true;
            byte[] bytes = request.Command is BridgeCommand command
                ? BridgeProtocol.NativeRequest(command) : BridgeProtocol.NativeRequest(request.Id, request.Op, executionId!);
            if (bytes.Length > limits.MaxRequestFrameBytes) throw new InvalidDataException();
            if (request.Command is not null)
            {
                Task<bool>? delivered;
                lock (gate)
                {
                    if (!OpenAtBoundaryLocked() || !CommandCurrentLocked(request.Command) || channelsDisposed || channel.LocallyClosing) return false;
                    request.PermitRequested = true;
                    delivered = output!.Enqueue(BridgeProtocol.PermitRequest(request.Id, request.Op, executionId!, request.Command.RequestFingerprint!));
                    if (delivered is null) FaultLocked();
                }
                if (delivered is null || !await delivered || !await request.Permit.Task.WaitAsync(admissionCancellation.Token))
                {
                    Fault(); return false;
                }
            }
            Task originalWrite;
            lock (gate)
            {
                // This is the last asynchronous send boundary. Stdio admission
                // alone is not permission to write after close/deadline/EOF.
                if (request.Op == "stop" && Stopwatch.GetElapsedTime(cleanupAnchor).TotalMilliseconds >= limits.CleanupTimeoutMs)
                    CleanupExpiredLocked();
                bool allowed = request.Op == "stop"
                    ? isSealed && acceptedClose && ReferenceEquals(stop, request) && !cleanupExpired
                    : OpenAtBoundaryLocked();
                if (request.Command is not null)
                    allowed = allowed && CommandCurrentLocked(request.Command) && request.PermitReceived;
                if (allowed && request.RequestAnchor is long anchor && Stopwatch.GetElapsedTime(anchor).TotalMilliseconds >= limits.RequestTimeoutMs)
                {
                    FaultLocked(); allowed = false;
                }
                if (!allowed || channelsDisposed || channel.LocallyClosing || pipeCancellation.IsCancellationRequested)
                {
                    channel.Pending.Remove(request.Id);
                    request.Response.TrySetResult(null);
                    return false;
                }
                invoked = true;
                request.WriteInvoked = true;
                originalWrite = channel.Pipe.WriteAsync(bytes, pipeCancellation.Token).AsTask();
            }
            await originalWrite;
            // NamedPipe WriteAsync completes the complete original byte frame;
            // it has no managed buffered writer to flush. A read-side EOF must
            // not turn that already completed stop write into a failed flush.
            lock (gate) if (request.Op == "stop") stopWritten = true;
            return true;
        }
        catch
        {
            lock (gate)
            {
                channel.Pending.Remove(request.Id);
                request.Response.TrySetResult(null);
                // Expected preemption before any write is only settlement.
                // Once invoked, a failed/cancelled write remains ambiguous.
                if (invoked || !isSealed) FaultLocked();
            }
            return false;
        }
        finally { if (acquired) channel.Writer.Release(); }
    }

    private async Task<FrameJoin> ReadNativeAsync(OriginalChannel channel)
    {
        FrameJoin joined = await BoundedFrameReader.ReadAsync(channel.Pipe, limits.MaxResponseFrameBytes, null, false,
            bytes =>
            {
                NativeMessage message = BridgeProtocol.Native(bytes, limits.MaxJsonDepth);
                JsonElement? background = null;
                if (message.State is JsonElement state && state.GetProperty("runtimeObservation").ValueKind != JsonValueKind.Null)
                {
                    BootBackgroundObservation? original;
                    lock (gate)
                    {
                        if (!runtimeRequested) throw new InvalidDataException();
                        original = runtimeBackground;
                    }
                    background = original?.Snapshot() ?? JsonSerializer.SerializeToElement(new { state = "unknown", reason = "unavailable" });
                }
                AcceptNative(channel, message, background);
            }, Fault,
            pipeCancellation.Token, () => { lock (gate) return channel.LocallyClosing; });
        if (joined == FrameJoin.Eof && !ReferenceEquals(channel, owner)) await ReconcilePendingPrepareReplyAsync();
        lock (gate)
        {
            if (joined == FrameJoin.ProofGap) FaultLocked();
            else if (joined == FrameJoin.Eof && prepareAccepted && !channel.LocallyClosing) BeginNaturalLocked();
            else if (!isSealed && !channel.LocallyClosing) FaultLocked();
            foreach (Operation request in channel.Pending.Values) request.Response.TrySetResult(null);
            channel.Pending.Clear();
        }
        return joined;
    }

    private void AcceptNative(OriginalChannel channel, NativeMessage message, JsonElement? background)
    {
        lock (gate)
        {
            if (message.State is JsonElement snapshot)
            {
                ValidateExecutionStateLocked(snapshot);
                if (snapshot.GetProperty("runtimeObservation").ValueKind != JsonValueKind.Null)
                    message = message with { State = BridgeProtocol.BindRuntimeObservation(snapshot, background!.Value, self!.User.Value) };
            }
            if (message.Kind == "event")
            {
                if (!ReferenceEquals(channel, observer) || !channel.Watched || message.ExecutionId != executionId)
                    throw new InvalidDataException();
                if (isSealed) return;
                byte[] state = BridgeProtocol.State(null, executionId!, message.State!.Value);
                bool admitted = bound ? output!.Enqueue(state) is not null : output!.RetainInitial(state);
                if (!admitted) FaultLocked();
                else RecordRuntimePublicationLocked(message.State!.Value);
                return;
            }
            if (message.RequestId is null || !channel.Pending.Remove(message.RequestId, out Operation? request))
                throw new InvalidDataException();
            if (message.Kind == "error")
            {
                if (message.Diagnostic is not null &&
                    (!ReferenceEquals(channel, owner) || !CurrentPrepareReplyLocked(request) || !OpenAtBoundaryLocked()))
                    throw new InvalidDataException();
                request.Response.TrySetResult(null);
                FaultLocked(message.Diagnostic); return;
            }
            if (message.Op != request.Op || message.Role != channel.Role || message.ExecutionId != executionId)
            {
                request.Response.TrySetResult(null);
                throw new InvalidDataException();
            }
            if (request.Op == "watch") channel.Watched = true;
            if (request.Op == "stop") stopReplied = true;
            request.Response.TrySetResult(message.State);
        }
    }

    private void RecordRuntimePublicationLocked(JsonElement state)
    {
        if (runtimeBackground is null) return;
        JsonElement observation = state.GetProperty("runtimeObservation");
        if (observation.ValueKind == JsonValueKind.Object && observation.GetProperty("background").GetProperty("state").GetString() == "observed")
            runtimeBackground.MarkPublishedObserved();
    }

    private void ValidateExecutionStateLocked(JsonElement state)
    {
        JsonElement fingerprint = state.GetProperty("requestFingerprint"), descriptor = state.GetProperty("descriptor");
        if (state.GetProperty("runtimeObservation").ValueKind != JsonValueKind.Null &&
            (!prepareAccepted || !runtimeRequested || fingerprint.ValueKind != JsonValueKind.String || descriptor.ValueKind != JsonValueKind.Object))
            throw new InvalidDataException();
        if (!prepareAccepted)
        {
            if (fingerprint.ValueKind != JsonValueKind.Null || descriptor.ValueKind != JsonValueKind.Null || state.GetProperty("authorizationVerified").GetBoolean()) throw new InvalidDataException();
            return;
        }
        if (fingerprint.ValueKind != JsonValueKind.Null && fingerprint.GetString() != preparePayload!.RequestFingerprint) throw new InvalidDataException();
        if (descriptor.ValueKind == JsonValueKind.Null) return;
        JsonElement details = descriptor.GetProperty("details");
        JsonElement target = JsonSerializer.SerializeToElement(preparePayload!.Scope.Target,
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        if (!JsonElement.DeepEquals(details.GetProperty("target"), target) || descriptor.GetProperty("executionId").GetString() != executionId ||
            details.GetProperty("executionPolicyFingerprint").GetString() != preparePayload.Scope.ExecutionPolicyFingerprint ||
            details.GetProperty("requestFingerprint").GetString() != preparePayload.RequestFingerprint ||
            details.GetProperty("installationManifestSha256").GetString() != configuration.ExpectedManifestSha256 ||
            !JsonElement.DeepEquals(details.GetProperty("supervisor"), JsonSerializer.SerializeToElement(helper!.WireIdentity)) ||
            (preparedDescriptor is JsonElement prepared && !JsonElement.DeepEquals(descriptor, prepared))) throw new InvalidDataException();
    }

    private void ObservationExpired()
    {
        lock (gate) OpenAtBoundaryLocked();
    }

    private bool CurrentPrepareReplyLocked(Operation request) => request.Op == "prepare" &&
        ReferenceEquals(request, executionOperation) && ReferenceEquals(request.Command, executionCommand) &&
        executionCommand?.Op == "prepare" && !channelsDisposed && owner is { LocallyClosing: false } &&
        request.WriteInvoked && request.PermitRequested && request.PermitReceived &&
        request.Permit.Task.IsCompletedSuccessfully && request.Permit.Task.Result &&
        request.RequestAnchor is long anchor && Stopwatch.GetElapsedTime(anchor).TotalMilliseconds < limits.RequestTimeoutMs;

    private async Task ReconcilePendingPrepareReplyAsync()
    {
        Task? response = null;
        lock (gate)
        {
            if (executionOperation is Operation request && CurrentPrepareReplyLocked(request) &&
                owner!.Pending.TryGetValue(request.Id, out Operation? pending) && ReferenceEquals(pending, request) &&
                !request.Response.Task.IsCompleted && OpenAtBoundaryLocked()) response = request.Response.Task;
        }
        // Other-channel EOF cannot discard the original owner reply; its existing request timer/close still preempts.
        if (response is not null)
            try { await response.WaitAsync(admissionCancellation.Token); }
            catch (OperationCanceledException) when (admissionCancellation.IsCancellationRequested) { }
    }

    private bool OpenAtBoundaryLocked()
    {
        if (isSealed) return false;
        double elapsed = Stopwatch.GetElapsedTime(launchAnchor).TotalMilliseconds;
        if (elapsed >= limits.SessionTimeoutMs || (!bound && elapsed >= limits.StartupTimeoutMs) ||
            (inspect is not null && Stopwatch.GetElapsedTime(inspectAnchor).TotalMilliseconds >= limits.RequestTimeoutMs) ||
            (softCommand is not null && !softSettled && Stopwatch.GetElapsedTime(softAnchor).TotalMilliseconds >= limits.RequestTimeoutMs) ||
            (forceCommand is not null && !forceSettled && Stopwatch.GetElapsedTime(forceAnchor).TotalMilliseconds >= limits.RequestTimeoutMs))
        {
            FaultLocked(); return false;
        }
        return true;
    }

    private bool CommandCurrentLocked(BridgeCommand command) => ReferenceEquals(executionCommand, command) || ReferenceEquals(softCommand, command) || ReferenceEquals(forceCommand, command);
    private bool CommandSettledLocked(BridgeCommand command) => ReferenceEquals(softCommand, command) ? softSettled : ReferenceEquals(forceCommand, command) && forceSettled;

    private void CancelPermitsLocked()
    {
        if (owner is not null) foreach (Operation operation in owner.Pending.Values) operation.Permit.TrySetResult(false);
    }

    private void Fault() { lock (gate) FaultLocked(); }

    private void FaultLocked(PrepareDiagnostic? diagnostic = null)
    {
        unknown = true;
        if (!isSealed) SealLocked();
        if (!unknownAttempted)
        {
            unknownAttempted = true;
            if (output?.Enqueue(BridgeProtocol.Unknown(executionCommand?.RequestId ?? inspect?.RequestId ?? closeRequestId, executionId, diagnostic)) is null)
                output?.Seal();
        }
        CloseChannelsLocked();
    }

    private void SealLocked()
    {
        if (isSealed) return;
        isSealed = true;
        long anchor = Stopwatch.GetTimestamp();
        cleanupAnchor = anchor;
        cleanupDeadline = new(anchor, limits.CleanupTimeoutMs, CleanupExpired);
        admissionCancellation.Cancel();
        CancelPermitsLocked();
        startupDeadline?.Cancel(); sessionDeadline?.Cancel();
        sealedSession.TrySetResult(true);
    }

    private void BeginNaturalLocked()
    {
        naturalEnding = true;
        SealLocked();
        EnsureEndingLocked();
    }

    private void EnsureEndingLocked()
    {
        if (!prepareAccepted || endingAttempted || executionId is null) return;
        endingAttempted = true;
        CancelPermitsLocked();
        endingWrite = output?.Enqueue(BridgeProtocol.Ending(executionId));
        if (endingWrite is null) unknown = true;
    }

    private void CleanupExpired()
    {
        lock (gate) CleanupExpiredLocked();
    }

    private void CleanupExpiredLocked()
    {
        if (gateH || cleanupExpired) return;
        cleanupExpired = true;
        FaultLocked();
        ForceOriginalHelperLocked();
    }

    private void ForceOriginalHelperLocked()
    {
        if (prepareAccepted || !cleanupExpired || helper is null || forceConsidered) return;
        forceConsidered = true;
        try
        {
            helper.RequireIdentity();
            if (helper.IsSignaled()) return;
            // The constructive allowlist has no prepare/authorize. This one
            // original-pin termination permission cannot extend to an engine.
            forceAttempted = true;
            unknown = true;
            helper.TerminateNoEngineHelperOnce();
        }
        catch { unknown = true; }
    }

    private void CloseChannelsLocked()
    {
        if (channelsDisposed) return;
        channelsDisposed = true;
        if (owner is not null) owner.LocallyClosing = true;
        if (observer is not null) observer.LocallyClosing = true;
        pipeCancellation.Cancel();
        try { ownerPipe?.Dispose(); } catch { unknown = true; }
        try { observerPipe?.Dispose(); } catch { unknown = true; }
    }

    private async Task CleanupHelperAndInputAsync()
    {
        Operation? shutdown = null;
        lock (gate)
        {
            if (Stopwatch.GetElapsedTime(cleanupAnchor).TotalMilliseconds >= limits.CleanupTimeoutMs)
                CleanupExpiredLocked();
            if (acceptedClose && !naturalEnding && !unknown && !cleanupExpired && owner is not null)
                shutdown = BeginOperationLocked(owner, "stop", null);
            else if (!naturalEnding) CloseChannelsLocked();
            EnsureEndingLocked();
            if (cleanupExpired) ForceOriginalHelperLocked();
        }
        if (shutdown is not null && !await shutdown.Write)
            Fault();

        bool attempted;
        Task<ExitObservation>? exit;
        lock (gate) { attempted = startAttempted; exit = helperExit; }
        if (attempted && (helper is null || exit is null))
        {
            // Start throw/false/adoption failure is an unresolved creation.
            // No PID enumeration, replacement launch or assumed absence.
            await retainedOwner.Task;
        }
        if (exit is not null)
        {
            ExitObservation observed = await exit;
            if (!observed.Proved || (prepareAccepted && observed.Code != 0)) await retainedOwner.Task;
            lock (gate) CloseChannelsLocked();
            if (helperOutput is null || helperError is null) await retainedOwner.Task;
            FrameJoin stdout = await helperOutput!;
            bool stderr = await helperError!;
            if (stdout != FrameJoin.Eof || !stderr) await retainedOwner.Task;
        }
        OriginalChannel? originalOwner, originalObserver;
        Task<bool>[] originalWrites;
        Task[] originalInspections;
        lock (gate)
        {
            CloseChannelsLocked();
            originalOwner = owner; originalObserver = observer;
            originalWrites = writes.ToArray(); originalInspections = inspections.ToArray();
        }
        if (originalOwner?.Reader is not null) await originalOwner.Reader;
        if (originalObserver?.Reader is not null) await originalObserver.Reader;
        await Task.WhenAll(originalWrites);
        await Task.WhenAll(originalInspections);
        if (endingWrite is not null && !await endingWrite) unknown = true;
        // Never close/destroy stdin locally to manufacture this last fact.
        if (input is null || await input != FrameJoin.Eof || !inputEof) await retainedOwner.Task;
        GC.KeepAlive(this);
    }
}

// A one-shot timer observes an immutable monotonic anchor. An early timer wake
// only arms its original remaining duration; messages never renew a deadline.
internal sealed class MonotonicDeadline : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly long anchor;
    private readonly int duration;
    private readonly Action expired;
    private readonly Timer timer;
    private bool stopped;

    internal MonotonicDeadline(long anchor, int duration, Action expired)
    {
        this.anchor = anchor; this.duration = duration; this.expired = expired;
        timer = new Timer(_ => Observe(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        lock (gate) ArmLocked();
    }

    private void ArmLocked()
    {
        double remaining = duration - Stopwatch.GetElapsedTime(anchor).TotalMilliseconds;
        timer.Change(TimeSpan.FromMilliseconds(Math.Max(0, Math.Ceiling(remaining))), Timeout.InfiniteTimeSpan);
    }

    private void Observe()
    {
        lock (gate)
        {
            if (stopped) return;
            if (Stopwatch.GetElapsedTime(anchor).TotalMilliseconds < duration) { ArmLocked(); return; }
            stopped = true;
        }
        expired();
    }

    internal void Cancel()
    {
        lock (gate)
        {
            if (stopped) return;
            stopped = true;
            timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        }
    }

    public async ValueTask DisposeAsync()
    {
        Cancel();
        await timer.DisposeAsync();
    }
}
