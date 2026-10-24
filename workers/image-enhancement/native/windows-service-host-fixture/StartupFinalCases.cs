using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Zeb.WindowsServiceHost;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsServiceHostFixture;

internal static partial class Program
{
    private static async Task<int> RunStartupFinalCaseAsync(string[] args)
    {
        string scenario = args[1], directory = Path.GetFullPath(args[2]);
        string node = Path.GetFullPath(args[3]), main = Path.GetFullPath(args[4]);
        int executionMs = int.Parse(args[5], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        Require(scenario is "bind" or "schema" or "ready", "startup_final_case_unknown");
        Require(executionMs is >= 1500 and <= 30_000 && cleanupMs is > 0 and <= 15_000 &&
            Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any(), "startup_final_empty_directory_and_budget");
        long cutoff = checked(Environment.TickCount64 + executionMs);
        using var execution = StartupRemaining(cutoff);
        string attempt = Guid.NewGuid().ToString(), operation = Guid.NewGuid().ToString();
        string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        string pipeName = "zeb-worker-startup-v1-" + attempt.Replace("-", "");
        using var user = WindowsIdentity.GetCurrent();
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        var caller = Native.Identity(new IntPtr(-1));
        string sid = user.User?.Value ?? throw new InvalidDataException("startup_final_sid_missing");
        string context = JsonSerializer.Serialize(new {
            v = 1, operationId = operation, startupAttemptId = attempt, startingReceiptSha256 = StartupHash("final-starting-receipt"u8),
            pipeName, nonce, cutoffTick64 = cutoff,
            caller = new { caller.Pid, caller.CreationFileTime, imagePath = Executable, imageSha256 = StartupFileHash(Executable),
                tokenUserSid = sid, sessionId = process.SessionId }, expectedServiceSid = sid,
            inventorySha256 = StartupHash("technical-final-inventory"u8),
            configSha256 = StartupHash(File.ReadAllBytes(Path.Combine(Path.GetDirectoryName(main)!, "worker.config.json"))),
            engineManifestSha256 = StartupHash("technical-final-engine"u8), hostSha256 = StartupFileHash(Executable), nodeSha256 = StartupFileHash(node)
        }, Json);
        string encoded = Convert.ToBase64String(Utf8.GetBytes(context)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance);
        var facts = new Dictionary<string, object?> { ["scenario"] = scenario, ["technicalSameUser"] = true,
            ["crossSidScmAccepted"] = false, ["contextSha256"] = StartupHash(Utf8.GetBytes(context)) };
        var failures = new List<string>();
        JobProcess? safety = null;
        ProcessPin? host = null, root = null;
        Task<StreamEnd>? outputDrain = null, errorDrain = null;
        StreamEnd? output = null, error = null;
        JsonElement? final = null;
        JobTreeExit? safetyTree = null;
        bool guardianUsed = false, originalsJoined = false, stopSent = false, observed = false;
        try
        {
            safety = JobProcess.Prepare(Executable, ["startup-final-host", scenario, directory, node, main, encoded,
                cutoff.ToString(CultureInfo.InvariantCulture), cleanupMs.ToString(CultureInfo.InvariantCulture)], directory);
            outputDrain = DrainAsync(safety.StandardOutput, capture: true);
            errorDrain = DrainAsync(safety.StandardError, capture: true);
            host = ProcessPin.OpenQualified(ToFact(safety.EngineIdentity), Executable, Native.FileIdentity(Executable), safety.JobName);
            Require(safety.AuthorizeOnce(), "startup_final_outer_host_authorize");
            await pipe.WaitForConnectionAsync(execution.Token);
            Native.Check(Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint peer), "startup_final_actual_host_peer");
            Require(peer == host.Identity.Pid && host.Alive, "startup_final_original_host_pin");
            var prepared = await ReadStartupFrameAsync(pipe, 8192, cutoff);
            RequireStartupFrame(prepared.Body, "prepared", 1, nonce, operation, attempt);
            Require(prepared.Body.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity, "startup_final_prepared_host_identity");
            string jobName = prepared.Body.GetProperty("jobName").GetString() ?? throw new InvalidDataException("startup_final_job_missing");
            root = ProcessPin.OpenQualified(prepared.Body.GetProperty("node").Deserialize<ProcessFact>(Json) ??
                throw new InvalidDataException("startup_final_node_identity_missing"), node, Native.FileIdentity(node), jobName);
            await safety.StandardInput.WriteAsync("inspect\n"u8.ToArray(), execution.Token);
            await safety.StandardInput.FlushAsync(execution.Token);
            var held = await WaitStartupMarkerAsync(directory, "startup-final-held.json", execution.Token);
            Require(held.GetProperty("root").Deserialize<ProcessFact>(Json) == root.Identity &&
                held.GetProperty("jobName").GetString() == jobName && !held.GetProperty("authorized").GetBoolean() &&
                !held.GetProperty("sealed").GetBoolean() && !held.GetProperty("processSignaled").GetBoolean() &&
                held.GetProperty("inOriginalJob").GetBoolean() && host.Alive && root.Alive,
                "startup_final_actual_same_owner_held_before_ack");
            facts["prepared"] = prepared.Body; facts["beforeAck"] = held;
            string preparedSha = StartupHash(prepared.Raw);
            byte[] ack = StartupFrame(new { v = 1, kind = "ack_prepared", seq = 2, nonce, operationId = operation,
                startupAttemptId = attempt, preparedSha256 = preparedSha,
                host = prepared.Body.GetProperty("host"), node = prepared.Body.GetProperty("node") });
            await pipe.WriteAsync(ack, execution.Token);
            var authorized = await ReadStartupFrameAsync(pipe, 1024, cutoff);
            RequireStartupFrame(authorized.Body, "authorized", 3, nonce, operation, attempt);
            Require(authorized.Body.GetProperty("authorized").GetBoolean() && authorized.Body.GetProperty("preparedSha256").GetString() == preparedSha &&
                authorized.Body.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity &&
                authorized.Body.GetProperty("node").Deserialize<ProcessFact>(Json) == root.Identity, "startup_final_original_authorized");
            facts["authorized"] = authorized.Body;
            var received = await ReadStartupFrameAsync(pipe, 8192, cutoff);
            final = received.Body;
            facts["final"] = final.Value; facts["finalWireBase64"] = Convert.ToBase64String(received.Raw);
            string kind = scenario == "ready" ? "ready" : "settled";
            if (scenario != "ready")
            {
                bool countPresent = final.Value.TryGetProperty("cleanupFailureCount", out var count);
                bool releasePresent = final.Value.TryGetProperty("ownerReleaseCompleted", out var release);
                Require(countPresent && releasePresent, "behavior_red_startup_settled_cleanup_fields_required");
                Require(count.ValueKind == JsonValueKind.Number && count.TryGetInt32(out int actualCount) && actualCount == 0 &&
                    release.ValueKind == JsonValueKind.True, "startup_settled_cleanup_fields_must_prove_expected_failure_only");
            }
            RequireStartupKeys(final.Value, scenario == "ready" ?
                ["v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node", "phase"] :
                ["v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node", "phase",
                    "jobName", "sealed", "ownerReleasedTreeActive", "forceCalls", "failureType", "cleanup",
                    "cleanupFailureCount", "ownerReleaseCompleted"]);
            RequireStartupKeys(final.Value.GetProperty("host"), ["pid", "creationFileTime"]);
            RequireStartupKeys(final.Value.GetProperty("node"), ["pid", "creationFileTime"]);
            Require(final.Value.GetProperty("v").GetInt32() == 1 && final.Value.GetProperty("kind").GetString() == kind &&
                final.Value.GetProperty("seq").GetInt32() == 4 && final.Value.GetProperty("nonce").GetString() == nonce &&
                final.Value.GetProperty("operationId").GetString() == operation && final.Value.GetProperty("startupAttemptId").GetString() == attempt &&
                final.Value.GetProperty("preparedSha256").GetString() == preparedSha &&
                final.Value.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity &&
                final.Value.GetProperty("node").Deserialize<ProcessFact>(Json) == root.Identity, "behavior_red_original_fourth_frame_required");
            var sourcePhase = await ReadStartupFinalSourcePhaseAsync(directory, execution.Token);
            RequireStartupKeys(sourcePhase, ["v", "kind", "attempt", "nonce", "phase", "runnerConstructed", "listenerSucceeded",
                "recoveryCalled", "claimEntered", "prepareEntered", "authorizeEntered"]);
            Require(sourcePhase.GetProperty("v").GetInt32() == 1 && sourcePhase.GetProperty("kind").GetString() == "startup_phase" &&
                sourcePhase.GetProperty("attempt").GetString() == attempt && sourcePhase.GetProperty("nonce").GetString() == nonce &&
                sourcePhase.GetProperty("phase").GetString() == (scenario == "ready" ? "listening" :
                    scenario == "bind" ? "listener_bind_failed" : "store_schema_incompatible") &&
                sourcePhase.GetProperty("runnerConstructed").GetBoolean() == (scenario != "schema") &&
                sourcePhase.GetProperty("listenerSucceeded").GetBoolean() == (scenario == "ready") &&
                !sourcePhase.GetProperty("recoveryCalled").GetBoolean() && !sourcePhase.GetProperty("claimEntered").GetBoolean() &&
                !sourcePhase.GetProperty("prepareEntered").GetBoolean() && !sourcePhase.GetProperty("authorizeEntered").GetBoolean() &&
                JsonElement.DeepEquals(sourcePhase, final.Value.GetProperty("phase")), "startup_final_must_forward_actual_typed_stderr_phase");
            byte[] end = new byte[1];
            Require(await pipe.ReadAsync(end, execution.Token) == 0, "startup_final_actual_eof_no_fifth_frame");
            pipe.Dispose();
            facts["sourcePhase"] = sourcePhase;
            facts["observationEof"] = true;
            if (scenario == "ready")
            {
                var returned = await WaitStartupMarkerAsync(directory, "startup-final-start-returned.json", execution.Token);
                Require(returned.GetProperty("startFailureType").ValueKind == JsonValueKind.Null && host.Alive && root.Alive &&
                    !returned.GetProperty("completionCompleted").GetBoolean(),
                    "behavior_red_ready_disarm_must_leave_original_worker_running");
                PublishStartupMarker(directory, "startup-final-ready-observed.json", new { host = host.Evidence(), node = root.Evidence(),
                    observationClosed = true, completionCompleted = false });
                Require(await Console.In.ReadLineAsync(execution.Token) == "stop", "startup_final_caller_health_then_explicit_stop");
                await SendStartupStopAsync(safety, execution.Token); stopSent = true;
            }
            else
            {
                Require(!root.Alive && root.ExitCode == 2 && final.Value.GetProperty("jobName").GetString() == jobName &&
                    final.Value.GetProperty("sealed").GetBoolean() && final.Value.GetProperty("ownerReleasedTreeActive").GetUInt32() == 0,
                    "startup_settled_requires_original_node_exit_and_owner_facts");
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
                    if (scenario == "ready" && !stopSent && host?.Alive == true)
                    { await SendStartupStopAsync(safety, cleanup.Token); stopSent = true; }
                    if (host is not null) await host.JoinAsync(cleanup.Token);
                    if (root is not null) await root.JoinAsync(cleanup.Token);
                    safetyTree = await safety.WaitForTreeExitAsync().WaitAsync(cleanup.Token);
                    if (outputDrain is not null) output = await outputDrain.WaitAsync(cleanup.Token);
                    if (errorDrain is not null) error = await errorDrain.WaitAsync(cleanup.Token);
                    Require(safetyTree.ActiveProcesses == 0 && output?.Eof == true && error?.Eof == true &&
                        output.ErrorType is null && error.ErrorType is null, "startup_final_outer_tree_and_dual_eof");
                    originalsJoined = true;
                }
                catch (Exception failure)
                {
                    guardianUsed = true; failures.Add("guardian: " + failure.GetType().Name + ": " + failure.Message);
                    using var guard = new CancellationTokenSource(cleanupMs);
                    try
                    {
                        safety.Force();
                        await safety.WaitForTreeExitAsync().WaitAsync(guard.Token);
                        if (host is not null) await host.JoinAsync(guard.Token);
                        if (root is not null) await root.JoinAsync(guard.Token);
                        if (outputDrain is not null) output = await outputDrain.WaitAsync(guard.Token);
                        if (errorDrain is not null) error = await errorDrain.WaitAsync(guard.Token);
                    }
                    catch (Exception guardFailure) { failures.Add("guardian-close: " + guardFailure.GetType().Name); }
                }
            }
            if (originalsJoined && output?.Utf8Base64 is { } raw)
            {
                try
                {
                    using var document = JsonDocument.Parse(Utf8.GetString(Convert.FromBase64String(raw)));
                    var completed = document.RootElement.Clone(); facts["completed"] = completed;
                    Require(completed.GetProperty("physicalCleanup").GetBoolean() && completed.GetProperty("secondStartRejected").GetBoolean() &&
                        completed.GetProperty("explicitStop").GetBoolean() == (scenario == "ready"), "startup_final_original_cleanup_required");
                    if (observed && scenario != "ready")
                    {
                        var actual = completed.GetProperty("cleanup");
                        RequireStartupKeys(final!.Value.GetProperty("cleanup"), ["rootExit", "treeExit", "stdout", "stderr"]);
                        foreach (string field in new[] { "rootExit", "treeExit", "stdout", "stderr" })
                            Require(JsonElement.DeepEquals(actual.GetProperty(field), final.Value.GetProperty("cleanup").GetProperty(field)),
                                "startup_final_cleanup_must_match_original_session");
                        Require(final.Value.GetProperty("forceCalls").GetInt32() == completed.GetProperty("graceful").GetProperty("forceCalls").GetInt32() &&
                            final.Value.GetProperty("failureType").GetString() == completed.GetProperty("completionFailureType").GetString() &&
                            completed.GetProperty("completionFailureType").ValueKind == JsonValueKind.String &&
                            completed.GetProperty("cleanup").GetProperty("rootExit").GetProperty("exitCode").GetUInt32() == 2,
                            "startup_final_preserve_original_failure_and_force_classification");
                        var settlement = completed.GetProperty("startupSettlement");
                        foreach (string field in new[] { "cleanupFailureCount", "ownerReleaseCompleted" })
                            Require(JsonElement.DeepEquals(settlement.GetProperty(field), final.Value.GetProperty(field)),
                                "startup_final_cleanup_fields_must_match_original_session_settlement");
                    }
                }
                catch (Exception failure) { failures.Add("host-evidence: " + failure.GetType().Name + ": " + failure.Message); }
            }
            facts["hostPin"] = host?.Evidence(); facts["nodePin"] = root?.Evidence();
            root?.Dispose(); host?.Dispose(); safety?.Dispose();
        }
        facts["safetyTree"] = safetyTree; facts["hostStdout"] = output; facts["hostStderr"] = error;
        facts["guardianUsed"] = guardianUsed; facts["originalsJoined"] = originalsJoined; facts["explicitStop"] = stopSent;
        facts["failures"] = failures; facts["passed"] = observed && originalsJoined && !guardianUsed && failures.Count == 0;
        facts["scope"] = "technical actual Worker stderr to original Host fourth frame; no SCM/cross-SID/FailureProof/Recover";
        return WriteCase(directory, facts);
    }

    private static async Task<int> RunStartupFinalHostAsync(string[] args)
    {
        string scenario = args[1], directory = args[2], node = args[3], main = args[4], encoded = args[5];
        long cutoff = long.Parse(args[6], CultureInfo.InvariantCulture);
        int cleanupMs = int.Parse(args[7], CultureInfo.InvariantCulture);
        using var window = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(1, cutoff - Environment.TickCount64 + cleanupMs)));
        using var rawOut = new FileStream(Path.Combine(directory, "startup-final.stdout.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var rawErr = new FileStream(Path.Combine(directory, "startup-final.stderr.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var session = new ContainedWorkerSession(node, [main], Path.GetDirectoryName(main)!,
            bytes => { rawOut.Write(bytes.Span); rawOut.Flush(); }, bytes => { rawErr.Write(bytes.Span); rawErr.Flush(); });
        using var observation = StartupObservation.CreateForTechnicalFixture(encoded);
        string? startFailureType = null, completionFailureType = null;
        bool explicitStop = false;
        Task start = Task.Run(() =>
        {
            try { session.Start(observation); } catch (Exception failure) { startFailureType = failure.GetType().Name; }
            finally { PublishStartupMarker(directory, "startup-final-start-returned.json", new {
                startFailureType, completionCompleted = session.Completion.IsCompleted }); }
        });
        Task command = Task.Run(async () =>
        {
            Require(await Console.In.ReadLineAsync(window.Token) == "inspect", "startup_final_host_inspect_command");
            var held = session.Inspect() ?? throw new InvalidDataException("startup_final_original_owner_absent");
            PublishStartupMarker(directory, "startup-final-held.json", new { root = ToFact(held.EngineIdentity), jobName = session.JobName,
                held.Authorized, held.Sealed, held.ProcessSignaled, held.InOriginalJob });
            if (scenario == "ready")
            {
                Require(await Console.In.ReadLineAsync(window.Token) == "stop", "startup_final_host_stop_command");
                explicitStop = true;
                Task original = session.StopAsync();
                try { await original.WaitAsync(window.Token); } catch (Exception) when (original.IsFaulted) { }
            }
        });
        await start.WaitAsync(window.Token);
        await command.WaitAsync(window.Token);
        try { await session.Completion.WaitAsync(window.Token); }
        catch (Exception failure) when (session.Completion.IsFaulted) { completionFailureType = failure.GetType().Name; }
        bool secondStartRejected = false;
        try { session.Start(); } catch (InvalidOperationException) { secondStartRejected = true; }
        var actual = session.CleanupObservation;
        bool physicalCleanup = actual.RootExit is not null && actual.TreeExit?.ActiveProcesses == 0 &&
            actual.Stdout.Eof && actual.Stderr.Eof && actual.Stdout.ReadFailureType is null && actual.Stderr.ReadFailureType is null &&
            actual.Stdout.SinkFailureType is null && actual.Stderr.SinkFailureType is null;
        Console.WriteLine(JsonSerializer.Serialize(new { physicalCleanup, secondStartRejected, explicitStop, startFailureType,
            completionFailureType, cleanup = CleanupFacts(actual), graceful = session.GracefulObservation,
            startupSettlement = OriginalStartupSettlement(session) }, Json));
        return physicalCleanup && secondStartRejected ? 0 : 1;
    }

    private static async Task<JsonElement> ReadStartupFinalSourcePhaseAsync(string directory, CancellationToken token)
    {
        while (true)
        {
            using var file = new FileStream(Path.Combine(directory, "startup-final.stderr.bin"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            Require(file.Length <= 65_536, "startup_final_source_capture_bound");
            using var reader = new StreamReader(file, Utf8);
            string text = reader.ReadToEnd();
            var lines = text.Split('\n').Where(line => line.StartsWith("ZEB_WORKER_STARTUP_V1 ", StringComparison.Ordinal)).ToArray();
            Require(lines.Length <= 1, "startup_final_actual_phase_must_be_single");
            if (lines.Length == 1 && text.Contains(lines[0] + "\n", StringComparison.Ordinal))
            {
                Require(Utf8.GetByteCount(lines[0] + "\n") <= 512, "startup_final_actual_phase_bound");
                using var parsed = JsonDocument.Parse(lines[0]["ZEB_WORKER_STARTUP_V1 ".Length..], new JsonDocumentOptions { MaxDepth = 4 });
                RejectStartupDuplicateKeys(parsed.RootElement); return parsed.RootElement.Clone();
            }
            await Task.Delay(5, token);
        }
    }
}
