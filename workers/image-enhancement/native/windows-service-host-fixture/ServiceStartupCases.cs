using System.Globalization;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Zeb.WindowsServiceHost;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsServiceHostFixture;

internal static partial class Program
{
    // Shared product scheduling only. This fixture never enters ServiceBase.Run or impersonates the service.
    private static async Task<int> RunServiceStartupCaseAsync(string[] args)
    {
        string scenario = args[1], directory = Path.GetFullPath(args[2]);
        string node = Path.GetFullPath(args[3]), main = Path.GetFullPath(args[4]);
        int executionMs = int.Parse(args[5], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        Require(scenario is "schedule" or "early-stop" or "post-authorize-disconnect" or "validation-before-start",
            "service_startup_case_unknown");
        Require(executionMs is >= 1500 and <= 30_000 && cleanupMs is > 0 and <= 15_000 &&
            Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any(),
            "service_startup_empty_directory_and_budget");
        bool noPrepare = scenario is "early-stop" or "validation-before-start";
        long cutoff = checked(Environment.TickCount64 + executionMs);
        using var execution = StartupRemaining(cutoff);
        string version = Path.Combine(directory, "program", "v1"), app = Path.Combine(version, "app");
        string store = Path.Combine(directory, "data", "store");
        Directory.CreateDirectory(app); Directory.CreateDirectory(store);
        File.Copy(main, Path.Combine(app, "main.mjs"), overwrite: false);
        WriteNew(Path.Combine(app, "worker.config.json"),
            new { storeDirectory = scenario == "validation-before-start" ? "relative-store" : store });
        using var identity = WindowsIdentity.GetCurrent();
        using var callerProcess = System.Diagnostics.Process.GetCurrentProcess();
        string sid = identity.User?.Value ?? throw new InvalidDataException("service_startup_sid_missing");
        var caller = Native.Identity(new IntPtr(-1));
        string attempt = Guid.NewGuid().ToString(), operation = Guid.NewGuid().ToString();
        string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        string pipeName = "zeb-worker-startup-v1-" + attempt.Replace("-", "");
        string context = JsonSerializer.Serialize(new {
            v = 1, operationId = operation, startupAttemptId = attempt, startingReceiptSha256 = StartupHash("service-starting-receipt"u8),
            pipeName, nonce, cutoffTick64 = cutoff,
            caller = new { caller.Pid, caller.CreationFileTime, imagePath = Executable, imageSha256 = StartupFileHash(Executable),
                tokenUserSid = sid, sessionId = callerProcess.SessionId }, expectedServiceSid = sid,
            inventorySha256 = StartupHash("technical-service-inventory"u8),
            configSha256 = StartupHash(File.ReadAllBytes(Path.Combine(app, "worker.config.json"))),
            engineManifestSha256 = StartupHash("technical-service-engine"u8),
            hostSha256 = StartupFileHash(Executable), nodeSha256 = StartupFileHash(node)
        }, Json);
        string encoded = Convert.ToBase64String(Utf8.GetBytes(context)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance);
        var facts = new Dictionary<string, object?> { ["scenario"] = scenario, ["technicalSameUser"] = true,
            ["crossSidScmAccepted"] = false, ["actualScmOnStartExercised"] = false };
        var failures = new List<string>();
        JobProcess? safety = null;
        ProcessPin? host = null, root = null;
        Task<StreamEnd>? outputDrain = null, errorDrain = null;
        StreamEnd? output = null, error = null;
        JobTreeExit? tree = null;
        bool guardianUsed = false, originalsJoined = false, stopSent = false, observed = false;
        try
        {
            safety = JobProcess.Prepare(Executable, ["service-startup-host", scenario, directory, node, version, encoded,
                cutoff.ToString(CultureInfo.InvariantCulture), cleanupMs.ToString(CultureInfo.InvariantCulture)], directory);
            outputDrain = DrainAsync(safety.StandardOutput, capture: true);
            errorDrain = DrainAsync(safety.StandardError, capture: true);
            host = ProcessPin.OpenQualified(ToFact(safety.EngineIdentity), Executable, Native.FileIdentity(Executable), safety.JobName);
            Require(safety.AuthorizeOnce(), "service_startup_original_fixture_host_authorize");
            if (noPrepare)
            {
                var noOwner = await WaitStartupMarkerAsync(directory, "service-startup-no-owner.json", execution.Token);
                Require(noOwner.GetProperty("noPrepare").GetBoolean() && noOwner.GetProperty("workerStarts").GetInt32() == 0 &&
                    !pipe.IsConnected && !File.Exists(Path.Combine(directory, "root-starts.ndjson")),
                    "service_startup_rejected_before_prepare");
                facts["noOwner"] = noOwner;
            }
            else
            {
                await pipe.WaitForConnectionAsync(execution.Token);
                Native.Check(Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint peer), "service_startup_original_pipe_peer");
                Require(peer == host.Identity.Pid && host.Alive, "service_startup_original_host_pin");
                var prepared = await ReadStartupFrameAsync(pipe, 8192, cutoff);
                RequireStartupFrame(prepared.Body, "prepared", 1, nonce, operation, attempt);
                Require(prepared.Body.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity, "service_startup_prepared_host");
                string jobName = prepared.Body.GetProperty("jobName").GetString() ?? throw new InvalidDataException("service_startup_job_missing");
                root = ProcessPin.OpenQualified(prepared.Body.GetProperty("node").Deserialize<ProcessFact>(Json) ??
                    throw new InvalidDataException("service_startup_root_missing"), node, Native.FileIdentity(node), jobName);
                var queued = await WaitStartupMarkerAsync(directory, "service-startup-queued.json", execution.Token);
                Require(queued.GetProperty("callReturned").GetBoolean() && queued.GetProperty("duplicateRejected").GetBoolean() &&
                    !queued.GetProperty("startupCompleted").GetBoolean() && !queued.GetProperty("lifecycleCompleted").GetBoolean(),
                    "behavior_red_service_observed_start_must_return_and_publish_one_pending_lifecycle_before_ack");
                await safety.StandardInput.WriteAsync("inspect\n"u8.ToArray(), execution.Token);
                await safety.StandardInput.FlushAsync(execution.Token);
                var held = await WaitStartupMarkerAsync(directory, "service-startup-held.json", execution.Token);
                Require(held.GetProperty("root").Deserialize<ProcessFact>(Json) == root.Identity &&
                    held.GetProperty("jobName").GetString() == jobName && !held.GetProperty("authorized").GetBoolean() &&
                    !held.GetProperty("sealed").GetBoolean() && !held.GetProperty("processSignaled").GetBoolean() &&
                    held.GetProperty("inOriginalJob").GetBoolean() && !held.GetProperty("startupCompleted").GetBoolean() &&
                    !held.GetProperty("lifecycleCompleted").GetBoolean() && host.Alive && root.Alive && RootStarts(directory) == 0,
                    "service_startup_held_ack_same_owner_and_pending_tasks");
                facts["queued"] = queued; facts["beforeAck"] = held;
                string preparedSha = StartupHash(prepared.Raw);
                byte[] ack = StartupFrame(new { v = 1, kind = "ack_prepared", seq = 2, nonce, operationId = operation,
                    startupAttemptId = attempt, preparedSha256 = preparedSha,
                    host = prepared.Body.GetProperty("host"), node = prepared.Body.GetProperty("node") });
                if (scenario == "post-authorize-disconnect")
                {
                    // One real attempt only. Missing this exact race is failure, never a retry or synthetic pass.
                    await pipe.WriteAsync(ack.AsMemory(0, ack.Length - 1), execution.Token);
                    await pipe.WriteAsync(ack.AsMemory(ack.Length - 1), execution.Token);
                    pipe.Dispose();
                }
                else
                {
                    await pipe.WriteAsync(ack, execution.Token);
                    var authorized = await ReadStartupFrameAsync(pipe, 1024, cutoff);
                    RequireStartupFrame(authorized.Body, "authorized", 3, nonce, operation, attempt);
                    Require(authorized.Body.GetProperty("authorized").GetBoolean() &&
                        authorized.Body.GetProperty("preparedSha256").GetString() == preparedSha &&
                        authorized.Body.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity &&
                        authorized.Body.GetProperty("node").Deserialize<ProcessFact>(Json) == root.Identity, "service_startup_original_authorized");
                }
                var returned = await WaitStartupMarkerAsync(directory, "service-startup-returned.json", execution.Token);
                if (scenario == "post-authorize-disconnect")
                {
                    var capture = returned.GetProperty("capture");
                    Require(returned.GetProperty("startFailureType").GetString() == "IOException" &&
                        capture.GetProperty("failureType").GetString() == "IOException" &&
                        capture.GetProperty("firstFailureRetained").GetBoolean() &&
                        capture.GetProperty("failureStage").GetString() == "write-authorized" &&
                        capture.GetProperty("ackValidated").GetBoolean() &&
                        capture.GetProperty("authorizationMayHaveOccurred").GetBoolean() &&
                        !capture.GetProperty("authorizedWriteReturned").GetBoolean() &&
                        capture.GetProperty("preparedFrameBase64").GetString() == Convert.ToBase64String(prepared.Raw) &&
                        capture.GetProperty("ackFrameBase64").GetString() == Convert.ToBase64String(ack),
                        "service_startup_post_authorize_race_target_not_reached");
                    using var attemptedWire = new MemoryStream(Convert.FromBase64String(capture.GetProperty("authorizedFrameBase64").GetString()!));
                    var attempted = await ReadStartupFrameAsync(attemptedWire, 1024, cutoff);
                    RequireStartupFrame(attempted.Body, "authorized", 3, nonce, operation, attempt);
                    Require(attemptedWire.Position == attemptedWire.Length && attempted.Body.GetProperty("authorized").GetBoolean() &&
                        attempted.Body.GetProperty("preparedSha256").GetString() == preparedSha &&
                        attempted.Body.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity &&
                        attempted.Body.GetProperty("node").Deserialize<ProcessFact>(Json) == root.Identity, "service_startup_attempted_not_received_authorized");
                    facts["disconnectRaceTargetReached"] = true;
                }
                else Require(returned.GetProperty("startFailureType").ValueKind == JsonValueKind.Null, "service_startup_positive_task_failed");
                while (!File.Exists(Path.Combine(directory, "root-first-action-complete"))) await Task.Delay(5, execution.Token);
                await safety.StandardInput.WriteAsync("checkpoint\n"u8.ToArray(), execution.Token);
                await safety.StandardInput.FlushAsync(execution.Token);
                var checkpoint = await WaitStartupMarkerAsync(directory, "service-startup-checkpoint.json", execution.Token);
                Require(checkpoint.GetProperty("startupCompleted").GetBoolean() && !checkpoint.GetProperty("completionCompleted").GetBoolean() &&
                    !checkpoint.GetProperty("lifecycleCompleted").GetBoolean() && checkpoint.GetProperty("sameLifecycle").GetBoolean() &&
                    host.Alive && root.Alive && RootStarts(directory) == 1 && !stopSent,
                    "behavior_red_startup_result_must_not_unwind_lifetime_or_kill_node_before_explicit_stop");
                facts["startReturned"] = returned; facts["beforeExplicitStop"] = checkpoint;
                await SendStartupStopAsync(safety, execution.Token); stopSent = true;
                if (scenario == "schedule")
                {
                    byte[] end = new byte[1];
                    Require(await pipe.ReadAsync(end, execution.Token) == 0, "service_startup_original_observation_eof_after_stop");
                }
            }
            observed = true;
        }
        catch (Exception failure) { failures.Add(failure.GetType().Name + ": " + failure.Message); }
        finally
        {
            if (safety is not null)
            {
                using var cleanup = new CancellationTokenSource(cleanupMs);
                try
                {
                    if (!noPrepare && !stopSent && host?.Alive == true)
                    { await SendStartupStopAsync(safety, cleanup.Token); stopSent = true; }
                    if (host is not null) await host.JoinAsync(cleanup.Token);
                    if (root is not null) await root.JoinAsync(cleanup.Token);
                    tree = await safety.WaitForTreeExitAsync().WaitAsync(cleanup.Token);
                    output = outputDrain is null ? null : await outputDrain.WaitAsync(cleanup.Token);
                    error = errorDrain is null ? null : await errorDrain.WaitAsync(cleanup.Token);
                    var census = safety.Inspect();
                    Require(tree.ActiveProcesses == 0 && output?.Eof == true && error?.Eof == true &&
                        output!.ErrorType is null && error!.ErrorType is null, "service_startup_original_outer_tree_and_eof");
                    if (noPrepare) Require(census.TotalProcesses == 1 && root is null, "service_startup_no_child_ever_created_in_safety_job");
                    facts["outerTotalProcesses"] = census.TotalProcesses;
                    originalsJoined = true;
                    using var document = JsonDocument.Parse(Utf8.GetString(Convert.FromBase64String(output!.Utf8Base64!)));
                    var child = document.RootElement.Clone(); facts["completed"] = child;
                    Require(child.GetProperty("lifecycleJoined").GetBoolean() && child.GetProperty("observationDisposed").GetBoolean() &&
                        child.GetProperty("secondStartRejected").GetBoolean() && child.GetProperty("workerStarts").GetInt32() == (noPrepare ? 0 : 1),
                        "service_startup_full_original_lifecycle_and_no_second_generation");
                    if (!noPrepare) Require(child.GetProperty("physicalCleanup").GetBoolean(), "service_startup_original_inner_cleanup");
                }
                catch (Exception failure)
                {
                    failures.Add("cleanup: " + failure.GetType().Name + ": " + failure.Message);
                    if (!originalsJoined)
                    {
                        guardianUsed = true;
                        using var guard = new CancellationTokenSource(cleanupMs);
                        try
                        {
                            safety.Force(); await safety.WaitForTreeExitAsync().WaitAsync(guard.Token);
                            if (host is not null) await host.JoinAsync(guard.Token);
                            if (root is not null) await root.JoinAsync(guard.Token);
                            if (outputDrain is not null) output = await outputDrain.WaitAsync(guard.Token);
                            if (errorDrain is not null) error = await errorDrain.WaitAsync(guard.Token);
                        }
                        catch (Exception guardFailure) { failures.Add("guardian: " + guardFailure.GetType().Name); }
                    }
                }
            }
            facts["hostPin"] = host?.Evidence(); facts["nodePin"] = root?.Evidence();
            root?.Dispose(); host?.Dispose(); safety?.Dispose();
        }
        facts["safetyTree"] = tree; facts["hostStdout"] = output; facts["hostStderr"] = error;
        facts["guardianUsed"] = guardianUsed; facts["originalsJoined"] = originalsJoined;
        facts["failures"] = failures; facts["passed"] = observed && originalsJoined && !guardianUsed && failures.Count == 0;
        facts["scope"] = "technical shared service startup scheduling/lifetime only; no actual SCM OnStart, cross-SID, caller, FailureProof or Recover";
        return WriteCase(directory, facts);
    }

    private static async Task<int> RunServiceStartupHostAsync(string[] args)
    {
        string scenario = args[1], directory = args[2], node = args[3], version = args[4], encoded = args[5];
        long cutoff = long.Parse(args[6], CultureInfo.InvariantCulture);
        int cleanupMs = int.Parse(args[7], CultureInfo.InvariantCulture);
        using var window = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(1, cutoff - Environment.TickCount64 + cleanupMs)));
        using var rawOut = new FileStream(Path.Combine(directory, "service-worker.stdout.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var rawErr = new FileStream(Path.Combine(directory, "service-worker.stderr.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var session = new ContainedWorkerSession(node, [Path.Combine(version, "app", "main.mjs"), directory], directory,
            bytes => rawOut.Write(bytes.Span), bytes => rawErr.Write(bytes.Span));
        using var service = new WindowsWorkerService(session);
        var observation = StartupObservation.CreateForTechnicalFixture(encoded);
        Task? startup = null;
        Exception? startFailure = null, lifecycleFailure = null;
        bool accepted = false, duplicateRejected = false, explicitStop = false;
        if (scenario == "early-stop") InvokeServiceOnStop(service);
        try { startup = service.BeginObservedStart(version, observation); accepted = true; }
        catch (InvalidOperationException failure) when (scenario == "early-stop")
        { startFailure = failure; observation.Dispose(); }
        Task lifecycle = service.StopObservation;
        if (accepted)
        {
            try { _ = service.BeginObservedStart(version, observation); }
            catch (InvalidOperationException) { duplicateRejected = true; }
            Require(duplicateRejected, "service_startup_duplicate_must_reject_before_queueing");
        }
        if (scenario is "schedule" or "post-authorize-disconnect")
            PublishStartupMarker(directory, "service-startup-queued.json", new { callReturned = true, duplicateRejected,
                startupCompleted = startup!.IsCompleted, lifecycleCompleted = lifecycle.IsCompleted });
        Task commands = scenario is "early-stop" or "validation-before-start" ? Task.CompletedTask : Task.Run(async () =>
        {
            string? command = await Console.In.ReadLineAsync(window.Token);
            if (command == "inspect")
            {
                var held = session.Inspect() ?? throw new InvalidDataException("service_startup_original_owner_missing");
                PublishStartupMarker(directory, "service-startup-held.json", new { root = ToFact(held.EngineIdentity),
                    jobName = session.JobName, held.Authorized, held.Sealed, held.ProcessSignaled, held.InOriginalJob,
                    startupCompleted = startup!.IsCompleted, lifecycleCompleted = lifecycle.IsCompleted });
                command = await Console.In.ReadLineAsync(window.Token);
            }
            if (command == "checkpoint")
            {
                PublishStartupMarker(directory, "service-startup-checkpoint.json", new {
                    startupCompleted = startup!.IsCompleted, completionCompleted = session.Completion.IsCompleted,
                    lifecycleCompleted = lifecycle.IsCompleted, sameLifecycle = ReferenceEquals(lifecycle, service.StopObservation) });
                command = await Console.In.ReadLineAsync(window.Token);
            }
            Require(command == "stop", "service_startup_explicit_stop_required");
            explicitStop = true;
            InvokeServiceOnStop(service);
        });
        if (startup is not null)
        {
            try { await startup.WaitAsync(window.Token); }
            catch (Exception failure) when (startup.IsFaulted) { startFailure = failure; }
        }
        PublishStartupMarker(directory, "service-startup-returned.json", new { startFailureType = startFailure?.GetType().Name,
            capture = StartupCaptureFacts(observation, startFailure) });
        if (scenario is "early-stop" or "validation-before-start")
        {
            Require(startFailure is not null &&
                (scenario == "early-stop" ? startFailure is InvalidOperationException : startFailure is InvalidDataException),
                "service_startup_expected_pre_start_rejection");
        }
        await commands.WaitAsync(window.Token);
        try { await lifecycle.WaitAsync(window.Token); }
        catch (Exception failure) when (lifecycle.IsFaulted) { lifecycleFailure = failure; }
        Require(lifecycleFailure is null || ReferenceEquals(lifecycleFailure, startFailure), "service_startup_original_error_not_replaced");
        Require(session.Completion.IsCompleted && (startFailure is null || !accepted || service.ExitCode != 0),
            "service_startup_error_retained_and_completion_joined");
        bool observationDisposed = false;
        try { observation.RequireAuthorizationWindow(); } catch (ObjectDisposedException) { observationDisposed = true; }
        Require(observationDisposed, "behavior_red_observation_must_be_disposed_by_joined_service_lifetime");
        bool secondStartRejected = false;
        try { session.Start(); } catch (InvalidOperationException) { secondStartRejected = true; }
        var actual = session.CleanupObservation;
        bool noPrepare = (scenario is "early-stop" or "validation-before-start") &&
            session.Inspect() is null && session.JobName is null && RootStarts(directory) == 0;
        bool physicalCleanup = actual.RootExit is not null && actual.TreeExit?.ActiveProcesses == 0 &&
            actual.Stdout.Eof && actual.Stderr.Eof && actual.Stdout.ReadFailureType is null && actual.Stderr.ReadFailureType is null &&
            actual.Stdout.SinkFailureType is null && actual.Stderr.SinkFailureType is null;
        if (scenario is "early-stop" or "validation-before-start")
        {
            Require(noPrepare && secondStartRejected, "service_startup_sealed_same_unstarted_session");
            PublishStartupMarker(directory, "service-startup-no-owner.json", new { noPrepare, workerStarts = RootStarts(directory),
                startFailureType = startFailure?.GetType().Name, lifecycleJoined = true, observationDisposed });
        }
        Console.WriteLine(JsonSerializer.Serialize(new { lifecycleJoined = lifecycle.IsCompleted, observationDisposed, secondStartRejected,
            noPrepare, physicalCleanup, startupAccepted = accepted, startupTaskJoined = startup?.IsCompleted ?? false,
            observationOwner = accepted ? "service" : "fixture-after-rejected-call", explicitStop,
            earlyOnStopInvoked = scenario == "early-stop", lateStartRejected = scenario == "early-stop" && startFailure is InvalidOperationException,
            startFailureType = startFailure?.GetType().Name, lifecycleFailureType = lifecycleFailure?.GetType().Name,
            workerStarts = RootStarts(directory), cleanup = CleanupFacts(actual), graceful = session.GracefulObservation }, Json));
        return secondStartRejected && observationDisposed && (noPrepare || physicalCleanup) ? 0 : 1;
    }

    private static void InvokeServiceOnStop(WindowsWorkerService service)
    {
        var method = typeof(WindowsWorkerService).GetMethod("OnStop", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
            ?? throw new InvalidDataException("service_startup_original_onstop_missing");
        method.Invoke(service, null);
    }
}
