using System.Globalization;
using System.Text;
using System.Text.Json;
#if ZEB_NATIVE_TESTS
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
#endif

namespace Zeb.WindowsSupervisor;

internal sealed record SessionOperationResult(string? ErrorCode, PrepareDiagnostic? Diagnostic = null)
{
    internal static readonly SessionOperationResult Success = new((string?)null);
}

internal sealed class NativeExecutionSession
{
    private const string RequestSlot = "00000000000000000000000000000001";
    private const string PreparedSlot = "00000000000000000000000000000002";
    private const string AuthSlot = "00000000000000000000000000000003";
    private const string LossSlot = "00000000000000000000000000000005";
    private const string TerminalSlot = "00000000000000000000000000000006";
    private const string PrepareDiagnosticSlot = "00000000000000000000000000000007";
    // System.Threading.Timer's documented maximum finite due time, in milliseconds.
    private const long TimerDomain = (long)uint.MaxValue - 1;
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase, MaxDepth = int.MaxValue,
    };
    private readonly object gate;
    private readonly string executionId, recordsRoot, installationRoot, manifestSha256;
    private readonly ControlProcess supervisor;
    private readonly Func<bool> ownerActive;
    private readonly Action changed;
    private readonly TaskCompletionSource<int> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task<int> joinedCompletion;
    private PreparePayload? payload;
    private TrustedInstallation? installation;
    private ProtectedJournal? journal;
    private JobProcess? job;
    private JsonElement? reservation, descriptor;
    private Task<SessionOperationResult>? prepareTask, authorizeTask;
    private Task<JobTreeExit?>? treeObservation;
    private Task<bool>? stdoutDrain, stderrDrain;
    private Task? naturalTask, cleanupTask;
    private volatile NvmlProgress? runtimeProgress;
    private NvmlObservation? nvml;
    private JsonElement? runtimeEngine, runtimeGpu;
    private Task? runtimeTask;
    private Timer? deadlineTimer;
    private string phase = "unclaimed", resumeState = "not-attempted";
    private string? cause, launchFailureStage, completedKind, prepareError, authorizeError;
    private long causeTick;
    private bool requestStarted, requestVerified, preparedStarted, preparedVerified;
    private bool authStarted, authVerified, prepareCalled, evidenceUnknown, terminalStarted, terminalVerified;
    private bool deadlineStopped, forceAttempted;
    private long? businessStart, businessEnd, graceDueTick;
    private Task<SessionOperationResult>? softStopTask, forceStopTask;
    private TaskCompletionSource timingChanged = new(TaskCreationOptions.RunContinuationsAsynchronously);
#if ZEB_NATIVE_TESTS
    private readonly SessionTestBridge? bridge;
    private bool prepareNativeFailure;
    private bool slowPrepareDiagnostic;
#endif

    internal NativeExecutionSession(object gate, string executionId, string recordsRoot,
        string installationRoot, string manifestSha256, ControlProcess supervisor,
        Func<bool> ownerActive, Action changed)
    {
        this.gate = gate;
        this.executionId = executionId;
        this.recordsRoot = recordsRoot;
        this.installationRoot = installationRoot;
        this.manifestSha256 = manifestSha256;
        this.supervisor = supervisor;
        this.ownerActive = ownerActive;
        this.changed = changed;
#if ZEB_NATIVE_TESTS
        bridge = SessionTestBridge.FromEnvironment(supervisor);
#endif
        joinedCompletion = JoinCompletionAsync();
    }

    internal Task<int> Completion => joinedCompletion;
    internal int? RemainingPrepareFailureReplyMilliseconds
    {
        get
        {
            lock (gate)
            {
                if (payload is null || cause is null || prepareCalled ||
                    prepareTask is not { IsCompletedSuccessfully: true } || prepareTask.Result.Diagnostic is null) return null;
                long due = checked(causeTick + payload.Limits.CancelGraceMs);
                return (int)Math.Clamp(due - Environment.TickCount64, 0, int.MaxValue);
            }
        }
    }
    internal bool IsSealed
    {
        get { lock (gate) { CheckDeadlineLocked(); return cause is not null || evidenceUnknown; } }
    }

    internal void Claimed()
    {
        lock (gate)
        {
            if (cause is null && !evidenceUnknown) phase = "claimed";
        }
    }

    internal object Snapshot()
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (runtimeGpu is JsonElement gpu) return new
            {
                phase, sealReason = cause, requestFingerprint = payload?.RequestFingerprint,
                descriptor, authorizationVerified = authVerified, resumeState,
                evidenceOutcome = terminalVerified ? "verified" : evidenceUnknown ? "unknown" : "pending",
                completion = completedKind,
                runtimeObservation = new { v = 1, background = (object?)null, engine = runtimeEngine, gpu },
            };
            return new
            {
                phase, sealReason = cause, requestFingerprint = payload?.RequestFingerprint,
                descriptor, authorizationVerified = authVerified, resumeState,
                evidenceOutcome = terminalVerified ? "verified" : evidenceUnknown ? "unknown" : "pending",
                completion = completedKind,
            };
        }
    }

    internal Task<SessionOperationResult> PrepareAsync(PreparePayload request)
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (payload is not null)
            {
                if (payload.RequestUtf8Base64 != request.RequestUtf8Base64 ||
                    payload.RequestFingerprint != request.RequestFingerprint)
                    return Result("payload_conflict");
                if (evidenceUnknown) return Result("unknown");
                if (prepareError is not null) return Result(prepareError);
                // Replays report the original state, including an operation still in flight.
                return Task.FromResult(SessionOperationResult.Success);
            }
            if (cause is not null || !ownerActive()) return Result("sealed");
            payload = request;
            CheckDeadlineLocked();
            if (cause is not null) return Result(RejectionLocked());
            phase = "preparing";
            prepareTask = Task.Run(RunPrepare);
            changed();
            return prepareTask;
        }
    }

    internal Task<SessionOperationResult> AuthorizeAsync(JsonElement target, JsonElement requestedDescriptor,
        string requestFingerprint)
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (evidenceUnknown) return Result("unknown");
            if (!preparedVerified || payload is null || descriptor is null || prepareTask is not { IsCompletedSuccessfully: true })
                return Result("not_prepared");
            if (requestFingerprint != payload.RequestFingerprint ||
                !SameJson(target, Element(payload.Scope.Target)) || !SameJson(requestedDescriptor, descriptor.Value))
                return Result("authorization_mismatch");
            if (authorizeTask is not null)
            {
                if (authorizeError is not null) return Result(authorizeError);
                return Task.FromResult(SessionOperationResult.Success);
            }
            if (cause is not null || !ownerActive()) return Result(RejectionLocked());
            authStarted = true;
            phase = "authorizing";
            authorizeTask = Task.Run(RunAuthorize);
            changed();
            return authorizeTask;
        }
    }

    internal bool Seal(string reason)
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            return SealLocked(reason);
        }
    }

    internal Task<SessionOperationResult> RequestStopAsync(JsonElement target, JsonElement requestedDescriptor,
        string requestFingerprint, string mode, long stopRequestedAt, long terminateAfterAt)
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (!ownerActive()) return Result("not_owner");
            if (evidenceUnknown || terminalStarted || terminalVerified) return Result("unknown");
            if (payload is null || descriptor is null || prepareTask is not { IsCompletedSuccessfully: true } ||
                authorizeTask is not { IsCompletedSuccessfully: true } || !preparedVerified || !authVerified || resumeState != "succeeded") return Result("not_authorized");
            if (cause is not null && cause is not ("stop" or "deadline" or "controller_exit" or "controller_eof" or "control_write_failure")) return Result("sealed");
            if (requestFingerprint != payload.RequestFingerprint || !SameJson(target, Element(payload.Scope.Target)) || !SameJson(requestedDescriptor, descriptor.Value)) return Result("authorization_mismatch");
            if (mode is not ("soft" or "force") || stopRequestedAt < 0 || terminateAfterAt > 9007199254740991 || terminateAfterAt <= stopRequestedAt ||
                checked(terminateAfterAt - stopRequestedAt) != payload.Limits.CancelGraceMs) return Result("invalid_stop");
            if (businessStart.HasValue && (businessStart != stopRequestedAt || businessEnd != terminateAfterAt)) return Result("stop_conflict");
            Task<SessionOperationResult>? previous = mode == "soft" ? softStopTask : forceStopTask;
            if (previous is not null) return previous;
            long tick = Environment.TickCount64, wall = Now;
            if ((!businessStart.HasValue && stopRequestedAt > wall) || (mode == "force" && !ForceEligible(wall, terminateAfterAt))) return Result("early_stop");
            long due;
            try
            {
                due = businessStart.HasValue ? graceDueTick!.Value : checked(tick + Math.Max(0, checked(terminateAfterAt - wall + 1)));
                if (!businessStart.HasValue && cause is not null) due = Math.Min(due, checked(causeTick + payload.Limits.CancelGraceMs));
            }
            catch (OverflowException) { return Result("invalid_stop"); }
            var accepted = Task.FromResult(SessionOperationResult.Success);
            if (mode == "soft") softStopTask = accepted; else forceStopTask = accepted;
            if (!businessStart.HasValue) { businessStart = stopRequestedAt; businessEnd = terminateAfterAt; }
            long nextDue = mode == "force" ? Math.Min(due, tick) : due;
            if (!graceDueTick.HasValue || nextDue < graceDueTick.Value || mode == "force")
            {
                graceDueTick = nextDue;
                TaskCompletionSource previousTiming = timingChanged;
                timingChanged = new(TaskCreationOptions.RunContinuationsAsynchronously);
                previousTiming.TrySetResult();
            }
            if (cause is null) SealLocked("stop");
            return accepted;
        }
    }

    internal void EvidenceFailed()
    {
        lock (gate) UnknownLocked("evidence-unknown");
    }

    private bool SealLocked(string reason, string? failureStage = null)
    {
        if (cause is not null || terminalVerified) return false;
        cause = reason;
        causeTick = Environment.TickCount64;
        launchFailureStage = failureStage;
        if (runtimeGpu is JsonElement gpu && gpu.GetProperty("state").GetString() == "pending")
            runtimeGpu = NvmlObservation.Unknown(reason == "deadline" ? "deadline" : "identity");
        phase = evidenceUnknown ? "unknown" : "sealed";
        StartCleanupLocked();
        changed();
        return true;
    }

    private void UnknownLocked(string reason)
    {
        if (terminalVerified) return;
        evidenceUnknown = true;
        phase = "unknown";
        if (!SealLocked(reason))
        {
            StartCleanupLocked();
            changed();
        }
    }

    private void StartCleanupLocked() => cleanupTask ??= Task.Run(CleanupAsync);

    private void CheckDeadlineLocked()
    {
        if (cause is null && payload is not null && Now > payload.ExecutionDeadlineAt)
            SealLocked("deadline");
    }

    private bool AdmitSetup()
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            return cause is null && !evidenceUnknown && ownerActive();
        }
    }

    private SessionOperationResult RunPrepare()
    {
        PreparePayload original = payload!;
        string prepareStage = "deadline";
        try
        {
            StartDeadline();
            if (!AdmitSetup()) return PrepareRejected();
            prepareStage = "installation_open";
            TrustedInstallation lease = TrustedInstallation.Open(installationRoot, manifestSha256, original.Engine);
            lock (gate) installation = lease;
            if (!AdmitSetup()) return PrepareRejected();
            prepareStage = "arguments";
            IReadOnlyList<string> argv = lease.CreateArguments(original.InputPath, original.OutputPath);
            if (!AdmitSetup()) return PrepareRejected();
            prepareStage = "reservation";
            JournalResult reserved = JournalOperation("reservation", () =>
                ProtectedJournal.Reserve(recordsRoot, original.Scope, executionId));
            lock (gate)
            {
                journal = reserved.Owner;
                if (reserved.Status != JournalStatus.Created || journal is null ||
                    !ValidateSnapshot(reserved, null, null))
                {
                    prepareError = "unknown";
                    UnknownLocked("evidence-unknown");
                    return new("unknown", PrepareDiagnostic.Create(prepareStage,
                        reserved.Diagnostic?.Stage, reserved.Diagnostic?.NativeError));
                }
                reservation = reserved.Snapshot!.Value.Clone();
            }
            prepareStage = "request_record";
            var requestRecord = Element(new
            {
                v = 1, kind = "windows-request", recordId = RequestSlot,
                requestFingerprint = original.RequestFingerprint, requestUtf8Base64 = original.RequestUtf8Base64,
                resolvedLaunch = new
                {
                    recipeId = lease.Launch.RecipeId,
                    installationManifestSha256 = lease.Launch.InstallationManifestSha256,
                    executablePath = lease.Launch.ExecutablePath, argv,
                },
            });
            lock (gate)
            {
                CheckDeadlineLocked();
                if (cause is not null || evidenceUnknown || !ownerActive()) return PrepareRejected();
                requestStarted = true;
            }
            prepareStage = "request_publish";
            bool requestValid = Publish("request", RequestSlot, requestRecord);
            lock (gate)
            {
                requestVerified = requestValid;
                if (!requestValid)
                {
                    prepareError = "unknown";
                    UnknownLocked("evidence-unknown");
                    return new("unknown");
                }
                CheckDeadlineLocked();
                if (cause is not null || evidenceUnknown || !ownerActive()) return PrepareRejected();
                // A thrown Prepare without a returned original object is not a no-tree receipt.
                prepareCalled = true;
            }
            prepareStage = "job_prepare";
            JobProcess originalJob;
#if ZEB_NATIVE_TESTS
            if (prepareNativeFailure)
                originalJob = JobProcess.PrepareForTest(lease.Launch.ExecutablePath, argv,
                    original.WorkingDirectory, PrepareFailurePoint.AttributeSetup);
            else
#endif
                originalJob = JobProcess.Prepare(lease.Launch.ExecutablePath, argv, original.WorkingDirectory);
            lock (gate) job = originalJob;
            prepareStage = "job_streams";
            // Both synchronous-handle streams get independent work items immediately on receipt.
            Stream output = originalJob.StandardOutput;
            Stream error = originalJob.StandardError;
            Task<JobTreeExit> originalTree = originalJob.WaitForTreeExitAsync();
            lock (gate)
            {
                treeObservation = ObserveTreeAsync(originalTree);
                stdoutDrain = Task.Run(() => DrainAsync(output, true));
                stderrDrain = Task.Run(() => DrainAsync(error, false));
                naturalTask = ObserveNaturalAsync(treeObservation, stdoutDrain, stderrDrain);
            }
            if (!AdmitSetup()) return PrepareRejected();
            prepareStage = "job_inspect";
            JobProcessObservation observed = originalJob.Inspect();
            if (!originalJob.IsPrepared || observed.EngineIdentity != originalJob.EngineIdentity ||
                observed.ProcessSignaled || !observed.InOriginalJob || observed.ActiveProcesses != 1 ||
                observed.TotalProcesses != 1 || observed.Authorized || observed.Sealed ||
                observed.JobHandleFlags != 0 || observed.ProcessHandleFlags != 0)
                throw new InvalidOperationException();
            prepareStage = "descriptor";
            JsonElement originalDescriptor = Element(new
            {
                adapterId = "windows-supervisor-v1", launchTicket = original.Scope.Target.LaunchTicket,
                executionId,
                details = new
                {
                    v = 1, target = original.Scope.Target,
                    executionPolicyFingerprint = original.Scope.ExecutionPolicyFingerprint,
                    requestFingerprint = original.RequestFingerprint, requestRecordId = RequestSlot,
                    preparedRecordId = PreparedSlot, recipeId = lease.Launch.RecipeId,
                    installationManifestSha256 = lease.Launch.InstallationManifestSha256,
                    supervisor = ProcessFact(supervisor.Pid, supervisor.CreationTime),
                    engine = ProcessFact(originalJob.EngineIdentity), jobName = originalJob.JobName,
                },
            });
            ValidateAuthorizationShape(Element(original.Scope.Target), originalDescriptor, original.RequestFingerprint);
            var preparedRecord = Element(new
            {
                v = 1, kind = "windows-prepared", recordId = PreparedSlot, requestRecordId = RequestSlot,
                requestFingerprint = original.RequestFingerprint,
                scope = new { target = original.Scope.Target, descriptor = originalDescriptor },
            });
            lock (gate)
            {
                CheckDeadlineLocked();
                if (cause is not null || evidenceUnknown || !ownerActive()) return PrepareRejected();
                preparedStarted = true;
            }
            prepareStage = "prepared_publish";
            bool preparedValid = Publish("prepared", PreparedSlot, preparedRecord);
            lock (gate)
            {
                preparedVerified = preparedValid;
                if (!preparedValid)
                {
                    prepareError = "unknown";
                    UnknownLocked("evidence-unknown");
                    return new("unknown");
                }
                descriptor = originalDescriptor;
                prepareStage = "runtime_observation";
                if (original.RuntimeObservation == "boot-v1")
                {
                    nvml = new NvmlObservation(
#if ZEB_NATIVE_TESTS
                        bridge, this
#endif
                    );
                    runtimeGpu = Element(new { state = "not-started" });
                    runtimeProgress = new NvmlProgress();
                }
                CheckDeadlineLocked();
                if (cause is null && !evidenceUnknown) phase = "prepared";
                changed();
            }
#if ZEB_NATIVE_TESTS
            Reach("prepared", "PreparedBeforeAck");
#endif
            lock (gate)
            {
                CheckDeadlineLocked();
                return cause is null && !evidenceUnknown ? SessionOperationResult.Success : PrepareRejected();
            }
        }
        catch (Exception error)
        {
            SessionOperationResult result;
            lock (gate)
            {
                if (prepareCalled && job is not null && !preparedStarted && !evidenceUnknown)
                {
                    prepareError = "prepare_failed";
                    SealLocked("launch-failure", "prepared-state");
                }
                else
                {
                    prepareError = prepareCalled && job is null ? "prepare_failed" : "unknown";
                    UnknownLocked("launch-failure");
                }
                PrepareDiagnostic? diagnostic = error switch
                {
                    InstallationException invalid => PrepareDiagnostic.Create(prepareStage,
                        invalid.Diagnostic.Stage, invalid.Diagnostic.NativeError),
                    JobPreparationException native => PrepareDiagnostic.Create(prepareStage, native.Stage, native.NativeErrorCode),
                    _ => PrepareDiagnostic.Create(prepareStage, null, null),
                };
                result = new(prepareError, diagnostic);
            }
            WritePrepareDiagnostic(prepareStage, error);
            return result;
        }
    }

    private void WritePrepareDiagnostic(string prepareStage, Exception error)
    {
#if ZEB_NATIVE_TESTS
        if (slowPrepareDiagnostic)
        {
            // Model a diagnostic I/O return after the real execution deadline.
            while (Now <= payload!.ExecutionDeadlineAt) Thread.Sleep(10);
            _ = Snapshot();
        }
#endif
        ProtectedJournal? original = journal;
        if (original is null) return;
        try
        {
            JobPreparationException? native = error as JobPreparationException;
            _ = original.Publish(PrepareDiagnosticSlot, Element(new
            {
                v = 1, kind = "windows-prepare-diagnostic", recordId = PrepareDiagnosticSlot,
                prepareStage, exceptionType = error.GetType().FullName,
                nativeStage = native?.Stage, nativeErrorCode = native?.NativeErrorCode,
            }));
        }
        // Diagnostics must not replace the original failure or grant recovery authority.
        catch { }
    }

    private SessionOperationResult PrepareRejected()
    {
        lock (gate)
        {
            prepareError = RejectionLocked();
            return new(prepareError);
        }
    }

    private SessionOperationResult RunAuthorize()
    {
        try
        {
            JsonElement authorization = Element(new { v = 1, recordId = AuthSlot, scope = InterruptionScope(), kind = "authorized" });
            bool verified = Publish("auth", AuthSlot, authorization);
            lock (gate)
            {
                authVerified = verified;
                if (!verified)
                {
                    authorizeError = "unknown";
                    UnknownLocked("evidence-unknown");
                    return new("unknown");
                }
                changed();
            }
#if ZEB_NATIVE_TESTS
            Reach("auth", "AuthVerifiedBeforeResumeGate");
#endif
            lock (gate)
            {
                CheckDeadlineLocked();
                if (cause is not null || evidenceUnknown || !ownerActive())
                {
                    authorizeError = RejectionLocked();
                    return new(authorizeError);
                }
                // The single native attempt is recorded before entering Job sync.
                resumeState = "uncertain";
                try
                {
                    if (job!.TryResumeOnceRetainingResources(out Exception? failure) && failure is null)
                    {
                        resumeState = "succeeded";
                        phase = "running";
                    }
                    else
                    {
                        authorizeError = "resume_failed";
                        SealLocked("launch-failure", "resume");
                    }
                }
                catch
                {
                    authorizeError = "resume_failed";
                    SealLocked("launch-failure", "resume");
                }
                changed();
                if (authorizeError is not null) return new(authorizeError);
            }
#if ZEB_NATIVE_TESTS
            Reach("auth", "AfterResumeBeforeAck");
#endif
            return SessionOperationResult.Success;
        }
        catch
        {
            lock (gate)
            {
                authorizeError = "unknown";
                UnknownLocked("evidence-unknown");
                return new("unknown");
            }
        }
    }

    private async Task<JobTreeExit?> ObserveTreeAsync(Task<JobTreeExit> originalTree)
    {
        try { return await originalTree; }
        catch
        {
            lock (gate) UnknownLocked("evidence-unknown");
            // The original monitor faults permanently. Never wait a replacement or reopen its Job.
            return null;
        }
    }

    private async Task<bool> DrainAsync(Stream stream, bool stdout)
    {
        try
        {
#if ZEB_NATIVE_TESTS
            if (stdout) Reach("prepared", "BeforeDrainRead");
#endif
            byte[] bytes = new byte[4096];
            int read;
            while ((read = await stream.ReadAsync(bytes)) != 0)
                if (!stdout && runtimeProgress?.Consume(bytes.AsSpan(0, read)) is true) QueueRuntimeObservation();
            return true;
        }
        catch
        {
            lock (gate) UnknownLocked("evidence-unknown");
            return false;
        }
    }

    private void QueueRuntimeObservation()
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (cause is not null || evidenceUnknown || nvml is null || runtimeTask is not null) return;
            runtimeGpu = Element(new { state = "pending" });
            runtimeTask = Task.Run(ObserveRuntime);
            changed();
        }
    }

    private void ObserveRuntime()
    {
        try
        {
            JobProcess original;
            NvmlObservation sampler;
            long deadline;
            lock (gate) { original = job!; sampler = nvml!; deadline = payload!.ExecutionDeadlineAt; }
            EngineRuntimeToken before;
            try { before = original.ReadRuntimeToken(); }
            catch (Exception failure) when (failure is System.ComponentModel.Win32Exception or InvalidDataException or ArgumentException)
            {
                string reason = failure is System.ComponentModel.Win32Exception native && native.NativeErrorCode == 5 ? "permission" : "identity";
                PublishRuntime(NvmlObservation.Unknown(reason), NvmlObservation.Unknown(reason));
                return;
            }
            JsonElement engine = before.SessionId == 0 ? Element(new { state = "observed", process = before.Wire }) : NvmlObservation.Unknown("identity");
            lock (gate)
            {
                CheckDeadlineLocked();
                if (cause is not null || evidenceUnknown) return;
                runtimeEngine = engine;
                changed();
            }
            JsonElement gpu = sampler.Sample(before.Pid, deadline);
            try
            {
                if (original.ReadRuntimeToken() != before) throw new InvalidDataException();
            }
            catch (Exception failure) when (failure is System.ComponentModel.Win32Exception or InvalidDataException or ArgumentException)
            { engine = NvmlObservation.Unknown("identity"); gpu = NvmlObservation.Unknown("identity"); }
            PublishRuntime(engine, gpu);
        }
        catch
        {
            lock (gate)
            {
                runtimeGpu = NvmlObservation.Unknown("unavailable");
                UnknownLocked("evidence-unknown");
            }
            // A failed resource release cannot manufacture a joined native task.
            throw;
        }
    }

    private void PublishRuntime(JsonElement engine, JsonElement gpu)
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (cause is not null || evidenceUnknown) return;
            runtimeEngine = engine; runtimeGpu = gpu;
            changed();
        }
    }

    private async Task ObserveNaturalAsync(Task<JobTreeExit?> tree, Task<bool> output, Task<bool> error)
    {
        JobTreeExit? proof = await tree;
        bool[] eof = await Task.WhenAll(output, error);
        if (proof is null || !eof.All(value => value)) return;
        lock (gate)
        {
            CheckDeadlineLocked();
            if (!evidenceUnknown && resumeState == "succeeded" && authVerified)
                SealLocked("engine-exit");
        }
    }

    private async Task CleanupAsync()
    {
        int exitCode = 0;
        try
        {
            Task<SessionOperationResult>? setup, authorization;
            lock (gate) { setup = prepareTask; authorization = authorizeTask; }
            if (setup is not null) await setup;
            if (authorization is not null) await authorization;
            JobProcess? original;
            Task<JobTreeExit?>? tree;
            Task<bool>? output, error;
            Task? natural;
            lock (gate)
            {
                original = job; tree = treeObservation; output = stdoutDrain; error = stderrDrain; natural = naturalTask;
                if (prepareCalled && original is null)
                {
                    UnknownLocked("evidence-unknown");
                    return; // Retain the lease and writer: Prepare provided no tree/EOF receipt.
                }
            }
            JobTreeExit? proof = null;
            bool dualEof = true;
            if (original is not null)
            {
                original.Seal();
                if (tree is null || output is null || error is null)
                {
                    lock (gate) UnknownLocked("evidence-unknown");
                    return;
                }
                bool resumed;
                lock (gate) resumed = resumeState == "succeeded";
                if (!tree.IsCompletedSuccessfully || tree.Result is null)
                {
                    if (resumed)
                    {
                        try { original.StandardInput.Dispose(); }
                        catch { lock (gate) UnknownLocked("evidence-unknown"); }
                        await WaitGraceOrTreeAsync(tree);
                    }
                    if (!tree.IsCompletedSuccessfully || tree.Result is null)
                    {
                        try
                        {
#if ZEB_NATIVE_TESTS
                            Reach("terminal", "BeforeForce");
#endif
                            bool needsForce;
                            lock (gate)
                            {
                                needsForce = !tree.IsCompletedSuccessfully || tree.Result is null;
                                if (needsForce)
                                {
                                    if (forceAttempted) throw new InvalidOperationException();
                                    forceAttempted = true;
                                }
                            }
                            if (needsForce)
                            {
#if ZEB_NATIVE_TESTS
                                if (bridge?.FaultAt("terminal", "BeforeForce") == "ForceQueryOnly")
                                    original.ForceQueryOnlyForTest();
                                else
#endif
                                    original.Force();
                            }
                        }
                        catch { lock (gate) UnknownLocked("evidence-unknown"); }
                    }
                }
                proof = await tree;
                if (proof is null)
                {
                    lock (gate) UnknownLocked("evidence-unknown");
                    return; // A process signal or EOF cannot repair the faulted original monitor.
                }
                bool[] eof = await Task.WhenAll(output, error);
                dualEof = eof.All(value => value);
                if (natural is not null) await natural;
                if (proof.ActiveProcesses != 0 || !dualEof)
                    lock (gate) UnknownLocked("evidence-unknown");
            }
            Task? observation;
            lock (gate) observation = runtimeTask;
            if (observation is not null) await observation;
#if ZEB_NATIVE_TESTS
            bridge?.SettleObservation(this);
#endif
            bool canPublish;
            lock (gate)
            {
                if ((requestStarted && !requestVerified) || (preparedStarted && !preparedVerified) ||
                    (authStarted && !authVerified)) UnknownLocked("evidence-unknown");
                canPublish = !evidenceUnknown && requestVerified && (original is null || (proof is not null && dualEof));
                if (canPublish)
                {
                    if (terminalStarted) throw new InvalidOperationException();
                    terminalStarted = true;
                }
            }
            if (canPublish)
            {
                bool verified;
                string finalKind;
                if (IsLoss(cause) && authVerified)
                {
                    JsonElement scope = InterruptionScope();
                    var loss = Element(new { v = 1, recordId = LossSlot, scope, kind = "controller-lost", authorizationRecordId = AuthSlot });
                    verified = AdmitTerminalRecord() && Publish("controllerLoss", LossSlot, loss);
                    if (verified)
                    {
                        var terminal = Element(new
                        {
                            v = 1, recordId = TerminalSlot, scope, kind = "terminal", completion = "interrupted",
                            authorizationRecordId = AuthSlot, controllerLossRecordId = LossSlot,
                            treeExited = true, authorizationsSealed = true,
                        });
                        verified = AdmitTerminalRecord() && Publish("terminal", TerminalSlot, terminal);
                    }
                    finalKind = "interrupted";
                }
                else
                {
                    JsonElement completionValue = CompletionRecord();
                    JsonElement proofValue = original is null
                        ? Element(new { kind = "prepare-not-called" })
                        : Element(new
                        {
                            kind = "engine-tree", engine = ProcessFact(original.EngineIdentity), jobName = original.JobName,
                            exitCode = proof!.EngineExitCode, treeExited = true, activeProcesses = 0,
                            stdoutEof = true, stderrEof = true,
                        });
                    var terminal = Element(new
                    {
                        v = 1, kind = "windows-terminal", recordId = TerminalSlot, scope = payload!.Scope,
                        requestRecordId = RequestSlot, requestFingerprint = payload.RequestFingerprint,
                        preparedRecordId = preparedVerified ? PreparedSlot : null,
                        descriptor = preparedVerified ? descriptor : null,
                        authorizationRecordId = authVerified ? AuthSlot : null, resumeState,
                        completion = completionValue, proof = proofValue, authorizationsSealed = true,
                    });
                    verified = AdmitTerminalRecord() && Publish("terminal", TerminalSlot, terminal);
                    finalKind = completionValue.GetProperty("kind").GetString()!;
                }
                lock (gate)
                {
                    if (verified && !evidenceUnknown)
                    {
                        terminalVerified = true;
                        completedKind = finalKind;
                        phase = "terminal";
                        changed();
                    }
                    else UnknownLocked("evidence-unknown");
                }
            }
            // No attempt before a verified request is a control shutdown, not an engine completion.
            lock (gate) if (evidenceUnknown) exitCode = 2;
            await StopDeadlineAsync();
            try { original?.Dispose(); } catch { exitCode = 2; }
            try { journal?.Dispose(); } catch { exitCode = 2; }
            try { installation?.Dispose(); } catch { exitCode = 2; }
            completion.TrySetResult(exitCode);
        }
        catch
        {
            lock (gate) UnknownLocked("evidence-unknown");
            // Unexpected cleanup cannot prove release safe. Keep Completion and original resources pending.
        }
    }

    private JsonElement CompletionRecord()
    {
        if (IsLoss(cause))
        {
            if (authStarted || resumeState != "not-attempted") throw new InvalidOperationException();
            return Element(new { kind = "unauthorized-cleanup", cause });
        }
        if (cause == "launch-failure")
        {
            if (launchFailureStage is not ("prepared-state" or "resume")) throw new InvalidOperationException();
            return Element(new { kind = "launch-failure", stage = launchFailureStage });
        }
        if (cause is not ("stop" or "deadline" or "engine-exit")) throw new InvalidOperationException();
        if (cause == "engine-exit" && (!authVerified || !preparedVerified || resumeState != "succeeded"))
            throw new InvalidOperationException();
        return Element(new { kind = cause });
    }

    private bool AdmitTerminalRecord()
    {
        lock (gate)
            return terminalStarted && !evidenceUnknown && requestVerified &&
                (!preparedStarted || preparedVerified) && (!authStarted || authVerified);
    }

    private async Task<int> JoinCompletionAsync()
    {
        int code = await completion.Task;
        Task? cleanup;
        lock (gate) cleanup = cleanupTask;
        if (cleanup is not null) await cleanup;
        return code;
    }

    private void StartDeadline()
    {
        lock (gate)
        {
            if (deadlineStopped || cause is not null) return;
            deadlineTimer = new Timer(_ =>
            {
                lock (gate)
                {
                    if (deadlineStopped || cause is not null) return;
                    CheckDeadlineLocked();
                    if (cause is null) ArmDeadlineLocked();
                }
            }, null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            CheckDeadlineLocked();
            if (cause is null) ArmDeadlineLocked();
        }
    }

    private void ArmDeadlineLocked() => deadlineTimer!.Change(
        TimeSpan.FromMilliseconds(Math.Min(TimerDomain, Math.Max(0, payload!.ExecutionDeadlineAt - Now + 1))),
        Timeout.InfiniteTimeSpan);

    private async Task StopDeadlineAsync()
    {
        Timer? timer;
        lock (gate) { deadlineStopped = true; timer = deadlineTimer; }
        if (timer is not null) await timer.DisposeAsync();
    }

    private async Task WaitGraceOrTreeAsync(Task<JobTreeExit?> tree)
    {
#if ZEB_NATIVE_TESTS
        bool waitObserved = false;
#endif
        var elapsed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var timerGate = new object();
        bool stopped = false;
        Timer? grace = null;
        void Arm()
        {
            lock (timerGate)
            {
                if (stopped) return;
                long remaining;
                lock (gate) remaining = Math.Max(0, (graceDueTick ?? checked(causeTick + payload!.Limits.CancelGraceMs)) - Environment.TickCount64);
                if (remaining <= 0) elapsed.TrySetResult();
                else grace!.Change(TimeSpan.FromMilliseconds(Math.Min(TimerDomain, remaining)), Timeout.InfiniteTimeSpan);
            }
        }
        grace = new Timer(_ => Arm(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        try
        {
            while (true)
            {
                Task timing;
                lock (gate)
                {
                    if (Environment.TickCount64 >= (graceDueTick ?? checked(causeTick + payload!.Limits.CancelGraceMs))) return;
                    timing = timingChanged.Task;
                }
                Arm();
#if ZEB_NATIVE_TESTS
                if (!waitObserved) { waitObserved = true; Reach("terminal", "GraceWaiting"); }
#endif
                Task observed = await Task.WhenAny(tree, elapsed.Task, timing);
                if (observed != timing) return;
            }
        }
        finally
        {
            lock (timerGate) stopped = true;
            await grace.DisposeAsync();
        }
    }

    private JournalResult JournalOperation(string slot, Func<JournalResult> operation)
    {
#if ZEB_NATIVE_TESTS
        return bridge is null ? operation() : bridge.Journal(slot, operation, this);
#else
        return operation();
#endif
    }

    private bool Publish(string slot, string recordId, JsonElement record)
    {
        JournalResult result = JournalOperation(slot, () => journal!.Publish(recordId, record));
        return ValidateSnapshot(result, recordId, record);
    }

    private bool ValidateSnapshot(JournalResult result, string? recordId, JsonElement? record)
    {
        try
        {
            if (result.Status is not (JournalStatus.Created or JournalStatus.Existing) || result.Snapshot is not { } value)
                return false;
            Exact(value, "v", "kind", "scope", "executionId", "recordId", "rootIdentity", "reservationIdentity", "fileIdentity", "record");
            if (!SameJson(value.GetProperty("v"), Element(1)) ||
                Text(value, "kind") != (recordId is null ? "reservation" : "record") ||
                Text(value, "executionId") != executionId || !SameJson(value.GetProperty("scope"), Element(payload!.Scope)))
                return false;
            foreach (string field in new[] { "rootIdentity", "reservationIdentity", "fileIdentity" })
                ValidateFileIdentity(value.GetProperty(field));
            if (reservation is { } reserved &&
                (!SameJson(value.GetProperty("rootIdentity"), reserved.GetProperty("rootIdentity")) ||
                 !SameJson(value.GetProperty("reservationIdentity"), reserved.GetProperty("reservationIdentity"))))
                return false;
            return recordId is null
                ? value.GetProperty("recordId").ValueKind == JsonValueKind.Null && value.GetProperty("record").ValueKind == JsonValueKind.Null
                : Text(value, "recordId") == recordId && record is { } expected &&
                  Text(expected, "recordId") == recordId && SameJson(value.GetProperty("record"), expected);
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or KeyNotFoundException or ArgumentException)
        {
            return false;
        }
    }

    private JsonElement InterruptionScope() => Element(new { target = payload!.Scope.Target, descriptor = descriptor!.Value });
    private static bool IsLoss(string? value) => value is "controller_eof" or "controller_exit" or "control_write_failure";
    private string RejectionLocked() => evidenceUnknown ? "unknown" : cause == "deadline" ? "deadline_exceeded" : "sealed";
    private static Task<SessionOperationResult> Result(string code) => Task.FromResult(new SessionOperationResult(code));
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static object ProcessFact(ProcessIdentity identity) => ProcessFact(checked((uint)identity.Pid), identity.CreationFileTime);
    private static object ProcessFact(uint pid, ulong creation) => new { pid, creationFileTime = creation.ToString(CultureInfo.InvariantCulture) };
    internal static JsonElement Element<T>(T value) => JsonSerializer.SerializeToElement(value, Json);

    internal static void Exact(JsonElement value, params string[] fields)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var remaining = new HashSet<string>(fields, StringComparer.Ordinal);
        foreach (JsonProperty field in value.EnumerateObject())
            if (!remaining.Remove(field.Name)) throw new InvalidDataException();
        if (remaining.Count != 0) throw new InvalidDataException();
    }

    internal static string Text(JsonElement value, string field)
    {
        JsonElement item = value.GetProperty(field);
        if (item.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        string result = item.GetString()!;
        new UTF8Encoding(false, true).GetByteCount(result);
        return result;
    }

    internal static bool Hex(string value, int length) => value.Length == length &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void Identifier(string value)
    {
        const string whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
        if (value.Length == 0 || whitespace.Contains(value[0]) || whitespace.Contains(value[^1]) ||
            value.Any(character => character <= 0x1f || character == 0x7f)) throw new InvalidDataException();
    }

    private static long PositiveInteger(JsonElement value, long maximum)
    {
        if (value.ValueKind != JsonValueKind.Number) throw new InvalidDataException();
        string raw = value.GetRawText();
        if (raw.Length == 0 || raw[0] == '0' || raw.Any(character => character is < '0' or > '9') ||
            !long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out long number) || number > maximum)
            throw new InvalidDataException();
        return number;
    }

    internal static long StopInteger(JsonElement value)
    {
        string token = value.GetRawText();
        if (value.ValueKind != JsonValueKind.Number || !long.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out long number) ||
            number < 0 || number > 9007199254740991 || number.ToString(CultureInfo.InvariantCulture) != token) throw new InvalidDataException();
        return number;
    }

    internal static bool ForceEligible(long wallNow, long terminateAfterAt) => wallNow > terminateAfterAt;

    internal static ulong DecimalUInt64(string value)
    {
        if (!ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong result) ||
            result.ToString(CultureInfo.InvariantCulture) != value) throw new InvalidDataException();
        return result;
    }

    private static void ValidateFileIdentity(JsonElement value)
    {
        Exact(value, "volumeSerial", "fileId");
        DecimalUInt64(Text(value, "volumeSerial"));
        if (!Hex(Text(value, "fileId"), 32)) throw new InvalidDataException();
    }

    internal static void ValidateAuthorizationShape(JsonElement target, JsonElement descriptor, string fingerprint)
    {
        void Target(JsonElement value)
        {
            Exact(value, "identity", "launchTicket");
            Identifier(Text(value, "launchTicket"));
            JsonElement identity = value.GetProperty("identity");
            Exact(identity, "jobId", "attemptNo", "ownerInstanceId", "fence");
            Identifier(Text(identity, "jobId")); Identifier(Text(identity, "ownerInstanceId"));
            PositiveInteger(identity.GetProperty("attemptNo"), 9007199254740991);
            PositiveInteger(identity.GetProperty("fence"), 9007199254740991);
        }
        void Process(JsonElement value)
        {
            Exact(value, "pid", "creationFileTime");
            PositiveInteger(value.GetProperty("pid"), uint.MaxValue);
            DecimalUInt64(Text(value, "creationFileTime"));
        }
        Target(target);
        Exact(descriptor, "adapterId", "launchTicket", "executionId", "details");
        Identifier(Text(descriptor, "launchTicket"));
        if (Text(descriptor, "adapterId") != "windows-supervisor-v1" ||
            !Hex(Text(descriptor, "executionId"), 32) || !Hex(fingerprint, 64)) throw new InvalidDataException();
        JsonElement details = descriptor.GetProperty("details");
        Exact(details, "v", "target", "executionPolicyFingerprint", "requestFingerprint", "requestRecordId",
            "preparedRecordId", "recipeId", "installationManifestSha256", "supervisor", "engine", "jobName");
        if (!SameJson(details.GetProperty("v"), Element(1)) ||
            !Hex(Text(details, "executionPolicyFingerprint"), 64) || !Hex(Text(details, "requestFingerprint"), 64) ||
            !Hex(Text(details, "installationManifestSha256"), 64) || Text(details, "requestRecordId") != RequestSlot ||
            Text(details, "preparedRecordId") != PreparedSlot || Text(details, "recipeId") != "upscayl-4x-png-v1")
            throw new InvalidDataException();
        Target(details.GetProperty("target"));
        Process(details.GetProperty("supervisor")); Process(details.GetProperty("engine"));
        Identifier(Text(details, "jobName"));
    }

    private static bool SameJson(JsonElement actual, JsonElement expected)
    {
        if (actual.ValueKind != expected.ValueKind) return false;
        if (actual.ValueKind == JsonValueKind.Object)
        {
            var properties = expected.EnumerateObject().ToDictionary(property => property.Name,
                property => property.Value, StringComparer.Ordinal);
            foreach (JsonProperty property in actual.EnumerateObject())
                if (!properties.Remove(property.Name, out JsonElement value) || !SameJson(property.Value, value)) return false;
            return properties.Count == 0;
        }
        if (actual.ValueKind == JsonValueKind.Array)
        {
            JsonElement[] first = actual.EnumerateArray().ToArray(), second = expected.EnumerateArray().ToArray();
            return first.Length == second.Length && first.Zip(second).All(pair => SameJson(pair.First, pair.Second));
        }
        return actual.ValueKind == JsonValueKind.String ? actual.GetString() == expected.GetString() : actual.GetRawText() == expected.GetRawText();
    }

#if ZEB_NATIVE_TESTS
    private void Reach(string slot, string stage)
    {
        if (bridge is null || !bridge.Reach(slot, stage, this)) return;
        string? fault = bridge.FaultAt(slot, stage);
        if (fault == "AddPrimarySuspension") job!.AddPrimarySuspensionForTest();
        else if (fault == "CloseOriginalJob") job!.CloseOriginalJobForTest();
        else if (fault == "DrainFailure") throw new IOException("Explicit test drain failure.");
    }

    internal object TestObservation(object? journalHandles, object? businessRequest = null)
    {
        lock (gate)
        {
            if (bridge?.FaultAt("observation", "BeforeNativeReturn") is not null) return new
            {
                executionId, requestFingerprint = payload?.RequestFingerprint, phase, sealReason = cause,
                engine = job is null ? null : ProcessFact(job.EngineIdentity), jobName = job?.JobName,
                journal = journalHandles, runtimeObservationTest = nvml!.TestCounters(),
            };
            if (businessStart.HasValue) return new
            {
                executionId, requestFingerprint = payload?.RequestFingerprint, phase, sealReason = cause,
                engine = job is null ? null : ProcessFact(job.EngineIdentity), jobName = job?.JobName, journal = journalHandles,
                business = new { stopRequestedAt = businessStart, terminateAfterAt = businessEnd, dueTick = graceDueTick, forceAttempted, request = businessRequest },
            };
            return new
            {
                executionId, requestFingerprint = payload?.RequestFingerprint, phase, sealReason = cause,
                engine = job is null ? null : ProcessFact(job.EngineIdentity), jobName = job?.JobName,
                journal = journalHandles,
            };
        }
    }

    internal void DisposeTestBridge() => bridge?.Dispose();

    internal long TestBudgetRemaining()
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            return cause is null ? Math.Max(0, payload!.ExecutionDeadlineAt - Now + 1)
                : Math.Max(0, payload!.Limits.CancelGraceMs - Math.Max(0, Environment.TickCount64 - causeTick));
        }
    }

    internal void TestPrepareFailure(bool slowDiagnostic = false)
    {
        prepareNativeFailure = true;
        slowPrepareDiagnostic = slowDiagnostic;
    }
#endif
}

#if ZEB_NATIVE_TESTS
// Entirely absent from the ordinary assembly. One immutable plan owns one real pipe barrier.
internal sealed class SessionTestBridge : IDisposable
{
    internal static bool RuntimeObservationAvailable => true;
    private readonly string leaf, nonce, slot, stage, fault;
    private readonly uint harnessPid;
    private readonly ulong harnessCreation;
    private readonly ControlProcess supervisor;
    private readonly long? fixtureDeadlineUnixMs;
    private NamedPipeClientStream? pipe;
    private StreamReader? input;
    private ControlProcess? harness;
    private ControlKernelHandle? duplicateProcess;
    private int reached;
    private int observationSettled;
    private bool observationReleased;

    private SessionTestBridge(JsonElement configuration, ControlProcess supervisor)
    {
        if (configuration.TryGetProperty("fixtureDeadlineUnixMs", out JsonElement fixtureDeadline))
        {
            NativeExecutionSession.Exact(configuration, "v", "pipe", "harnessPid", "harnessCreatedFileTime", "nonce", "plan", "fixtureDeadlineUnixMs");
            fixtureDeadlineUnixMs = NativeExecutionSession.StopInteger(fixtureDeadline);
        }
        else NativeExecutionSession.Exact(configuration, "v", "pipe", "harnessPid", "harnessCreatedFileTime", "nonce", "plan");
        if (configuration.GetProperty("v").GetRawText() != "1") throw new InvalidDataException();
        leaf = NativeExecutionSession.Text(configuration, "pipe");
        nonce = NativeExecutionSession.Text(configuration, "nonce");
        const string prefix = "zeb-session-test-";
        if (!leaf.StartsWith(prefix, StringComparison.Ordinal) ||
            !NativeExecutionSession.Hex(leaf[prefix.Length..], 32) || !NativeExecutionSession.Hex(nonce, 32))
            throw new InvalidDataException();
        string pid = configuration.GetProperty("harnessPid").GetRawText();
        if (!uint.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out harnessPid) ||
            harnessPid == 0 || harnessPid.ToString(CultureInfo.InvariantCulture) != pid) throw new InvalidDataException();
        harnessCreation = NativeExecutionSession.DecimalUInt64(NativeExecutionSession.Text(configuration, "harnessCreatedFileTime"));
        this.supervisor = supervisor;
        JsonElement plan = configuration.GetProperty("plan");
        if (plan.ValueKind == JsonValueKind.Null) { slot = stage = fault = ""; return; }
        NativeExecutionSession.Exact(plan, "slot", "stage", "fault");
        slot = NativeExecutionSession.Text(plan, "slot"); stage = NativeExecutionSession.Text(plan, "stage");
        fault = NativeExecutionSession.Text(plan, "fault");
        if (slot is not ("reservation" or "request" or "prepared" or "auth" or "controllerLoss" or "terminal" or "stop" or "observation"))
            throw new InvalidDataException();
        bool observationPlan = (slot, stage) == ("observation", "BeforeNativeReturn");
        if (slot == "observation" && !observationPlan) throw new InvalidDataException();
        bool journalStage = Enum.TryParse(stage, out JournalTestStage parsed) && parsed.ToString() == stage;
        bool validStage = journalStage
            ? stage is "BeforeWrite" or "BeforeFlush" || (slot == "reservation"
                ? stage is "MarkerCreated" or "ReservationWritten" or "ReservationFlushed" or "ReservationRenamed" or "ReservationVerified"
                : stage is "RecordWritten" or "RecordFlushed" or "RecordRenamed" or "RecordVerified")
            : (slot, stage) is ("prepared", "PreparedBeforeAck") or ("auth", "AuthVerifiedBeforeResumeGate") or
                ("auth", "AfterResumeBeforeAck") or ("terminal", "BeforeForce") or ("terminal", "GraceWaiting") or ("stop", "StopBeforeAck") or ("prepared", "BeforeDrainRead") or ("observation", "BeforeNativeReturn");
        bool validFault = fault switch
        {
            "None" => slot != "observation",
            "WriteReadOnly" => journalStage && stage == "BeforeWrite",
            "FlushReadOnly" => journalStage && stage == "BeforeFlush",
            "AddPrimarySuspension" => slot == "auth" && stage == "AuthVerifiedBeforeResumeGate",
            "ForceQueryOnly" or "CloseOriginalJob" => slot == "terminal" && stage == "BeforeForce",
            "DrainFailure" => slot == "prepared" && stage == "BeforeDrainRead",
            "PrepareNativeFailure" or "PrepareNativeFailureSlowDiagnostic" => slot == "request" && stage == "RecordVerified",
            "NvmlGraphicsOnly" or "NvmlComputeOnly" or "NvmlMultiDevice" or "NvmlPermission" or "NvmlNoMatch" or "NvmlFillIncomplete" or "NvmlBlockedReturn" => observationPlan,
            _ => false,
        };
        bool fixedStopGate = (slot, stage) is ("terminal", "BeforeForce") or ("terminal", "GraceWaiting") or ("stop", "StopBeforeAck");
        if (!validStage || !validFault || (fixtureDeadlineUnixMs.HasValue && !fixedStopGate)) throw new InvalidDataException();
    }

    internal static SessionTestBridge? FromEnvironment(ControlProcess supervisor)
    {
        string? configuration = Environment.GetEnvironmentVariable("ZEB_NATIVE_SESSION_TEST_BRIDGE");
        if (configuration is null) return null;
        new UTF8Encoding(false, true).GetByteCount(configuration);
        using JsonDocument document = JsonDocument.Parse(configuration, new JsonDocumentOptions { MaxDepth = int.MaxValue });
        return new SessionTestBridge(document.RootElement, supervisor);
    }

    internal static SessionTestBridge? FromStopAckEnvironment(ControlProcess supervisor)
    {
        string? configuration = Environment.GetEnvironmentVariable("ZEB_NATIVE_STOP_ACK_TEST_BRIDGE");
        if (configuration is null) return null;
        using JsonDocument document = JsonDocument.Parse(configuration, new JsonDocumentOptions { MaxDepth = int.MaxValue });
        var bridge = new SessionTestBridge(document.RootElement, supervisor);
        if (bridge.slot != "stop" || bridge.stage != "StopBeforeAck" || bridge.fault != "None" || !bridge.fixtureDeadlineUnixMs.HasValue) throw new InvalidDataException();
        return bridge;
    }

    internal string? FaultAt(string actualSlot, string actualStage) =>
        actualSlot == slot && actualStage == stage ? fault : null;

    internal JournalResult Journal(string actualSlot, Func<JournalResult> operation, NativeExecutionSession session)
    {
        JournalTestControl.Fault = actualSlot == slot ? fault switch
        {
            "WriteReadOnly" => JournalTestFault.WriteReadOnly,
            "FlushReadOnly" => JournalTestFault.FlushReadOnly,
            _ => JournalTestFault.None,
        } : JournalTestFault.None;
        JournalTestControl.Observer = (actualStage, original, selected) =>
        {
            string name = actualStage.ToString();
            if (Reach(actualSlot, name, session, original, selected) && fault is "PrepareNativeFailure" or "PrepareNativeFailureSlowDiagnostic")
                session.TestPrepareFailure(slowDiagnostic: fault == "PrepareNativeFailureSlowDiagnostic");
        };
        try { return operation(); }
        finally { JournalTestControl.Observer = null; JournalTestControl.Fault = JournalTestFault.None; }
    }

    internal bool Reach(string actualSlot, string actualStage, NativeExecutionSession session,
        SafeFileHandle? original = null, SafeFileHandle? selected = null, object? businessRequest = null)
    {
        if (actualSlot != slot || actualStage != stage) return false;
        if (Interlocked.Exchange(ref reached, 1) != 0) throw new InvalidDataException();
        using var budget = new BridgeBudget(fixtureDeadlineUnixMs is long deadline
            ? () => Math.Max(0, deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1) : session.TestBudgetRemaining);
        EnsureConnected(budget.Token);
        IntPtr originalCopy = IntPtr.Zero, selectedCopy = IntPtr.Zero;
        bool released = false;
        try
        {
            object? journalHandles = null;
            if ((fault == "WriteReadOnly" && actualStage == "BeforeWrite") ||
                (fault == "FlushReadOnly" && actualStage == "BeforeFlush"))
            {
                if (original is null || selected is null) throw new InvalidDataException();
                originalCopy = DuplicateToHarness(original);
                selectedCopy = DuplicateToHarness(selected);
                journalHandles = new { originalHandle = HandleText(originalCopy), selectedHandle = HandleText(selectedCopy) };
            }
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
            {
                v = 1, kind = "reached", nonce, sequence = 1, slot = actualSlot, stage = actualStage,
                observation = session.TestObservation(journalHandles, businessRequest),
            }, NativeExecutionSession.Json);
            Array.Resize(ref bytes, bytes.Length + 1); bytes[^1] = (byte)'\n';
            pipe!.WriteAsync(bytes, budget.Token).AsTask().GetAwaiter().GetResult();
            // Only this simulated native return is noncancellable. Expiry seals facts,
            // but cannot stand in for the original native invocation returning.
            string? line = input!.ReadLineAsync(slot == "observation" ? CancellationToken.None : budget.Token).AsTask().GetAwaiter().GetResult();
            if (line is null) throw new InvalidDataException();
            using JsonDocument document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = int.MaxValue });
            JsonElement release = document.RootElement;
            NativeExecutionSession.Exact(release, "v", "kind", "nonce", "sequence");
            if (release.GetProperty("v").GetRawText() != "1" || NativeExecutionSession.Text(release, "kind") != "release" ||
                NativeExecutionSession.Text(release, "nonce") != nonce || release.GetProperty("sequence").GetRawText() != "1")
                throw new InvalidDataException();
            released = true;
            if (slot == "observation") observationReleased = true;
            return true;
        }
        finally
        {
            // The bound harness closes transferred copies before release. On a failed handshake
            // reclaim only these exact copies; never enumerate handles or automatically release.
            if (!released)
            {
                CloseRemoteCopy(originalCopy);
                CloseRemoteCopy(selectedCopy);
            }
        }
    }

    internal void SettleObservation(NativeExecutionSession session)
    {
        if (slot != "observation" || !observationReleased) return;
        if (Interlocked.Exchange(ref observationSettled, 1) != 0) throw new InvalidDataException();
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            v = 1, kind = "settled", nonce, sequence = 2, slot, stage,
            observation = session.TestObservation(null),
        }, NativeExecutionSession.Json);
        Array.Resize(ref bytes, bytes.Length + 1); bytes[^1] = (byte)'\n';
        pipe!.WriteAsync(bytes, CancellationToken.None).AsTask().GetAwaiter().GetResult();
    }

    private void EnsureConnected(CancellationToken token)
    {
        if (pipe is not null) return;
        var connected = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous,
            System.Security.Principal.TokenImpersonationLevel.Identification);
        try
        {
            connected.ConnectAsync(token).GetAwaiter().GetResult();
            ControlNativeMethods.RequireNoninherited(connected.SafePipeHandle);
            if (!GetNamedPipeServerProcessId(connected.SafePipeHandle, out uint pid))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (pid != harnessPid) throw new InvalidDataException();
            ControlProcess pin = ControlProcess.Open(pid);
            try
            {
                if (pin.CreationTime != harnessCreation || !pin.User.Equals(supervisor.User)) throw new InvalidDataException();
                pin.RequireRunning();
                ControlKernelHandle duplicator = ControlNativeMethods.OpenProcess(0x00101040, false, pid);
                try
                {
                    if (duplicator.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    ControlNativeMethods.RequireNoninherited(duplicator);
                    if (ControlNativeMethods.GetProcessId(duplicator) != pid ||
                        !ControlNativeMethods.GetProcessTimes(duplicator, out ulong creation, out _, out _, out _) ||
                        creation != harnessCreation || !ControlNativeMethods.ReadUser(duplicator).Equals(pin.User) ||
                        ControlNativeMethods.WaitForSingleObject(duplicator, 0) != 258) throw new InvalidDataException();
                    duplicateProcess = duplicator;
                }
                catch { duplicator.Dispose(); throw; }
                harness = pin;
            }
            catch { pin.Dispose(); throw; }
            input = new StreamReader(connected, new UTF8Encoding(false, true), false, leaveOpen: true);
            pipe = connected;
        }
        catch { connected.Dispose(); throw; }
    }

    private IntPtr DuplicateToHarness(SafeFileHandle source)
    {
        if (!DuplicateHandle(new IntPtr(-1), source, duplicateProcess!, out IntPtr duplicate, 0, false, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return duplicate;
    }

    private void CloseRemoteCopy(IntPtr copy)
    {
        if (copy == IntPtr.Zero || duplicateProcess is null) return;
        bool copied = ReclaimHandle(duplicateProcess, copy, new IntPtr(-1), out SafeFileHandle local, 0, false, 3);
        int nativeError = Marshal.GetLastWin32Error();
        local.Dispose();
        if (!copied && nativeError != 6) throw new Win32Exception(nativeError);
    }

    private static string HandleText(IntPtr value) => unchecked((ulong)value.ToInt64()).ToString(CultureInfo.InvariantCulture);

    public void Dispose()
    {
        input?.Dispose(); pipe?.Dispose(); duplicateProcess?.Dispose(); harness?.Dispose();
    }

    private sealed class BridgeBudget : IDisposable
    {
        private readonly object timerGate = new();
        private readonly CancellationTokenSource cancellation = new();
        private readonly Timer timer;
        private readonly Func<long> remaining;
        private bool stopped;
        internal CancellationToken Token => cancellation.Token;
        internal BridgeBudget(Func<long> remaining)
        {
            this.remaining = remaining;
            timer = new Timer(_ => Arm(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            Arm();
        }
        private void Arm()
        {
            lock (timerGate)
            {
                if (stopped) return;
                long due = remaining();
                if (due <= 0) cancellation.Cancel();
                else timer.Change(TimeSpan.FromMilliseconds(Math.Min((long)uint.MaxValue - 1, due)), Timeout.InfiniteTimeSpan);
            }
        }
        public void Dispose()
        {
            lock (timerGate) stopped = true;
            timer.DisposeAsync().AsTask().GetAwaiter().GetResult();
            cancellation.Dispose();
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, ControlKernelHandle targetProcess,
        out IntPtr target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", EntryPoint = "DuplicateHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReclaimHandle(ControlKernelHandle sourceProcess, IntPtr source, IntPtr targetProcess,
        out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
}
#endif
