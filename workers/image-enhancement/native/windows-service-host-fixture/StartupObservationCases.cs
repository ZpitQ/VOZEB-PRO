using System.Buffers.Binary;
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
    // This is an IVT-only, same-user technical case, not an SCM or cross-SID acceptance.
    private static async Task<int> RunStartupObservationCaseAsync(string[] args)
    {
        string scenario = args[1], directory = Path.GetFullPath(args[2]);
        string node = Path.GetFullPath(args[3]), main = Path.GetFullPath(args[4]);
        int executionMs = int.Parse(args[5], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        Require(scenario is "ack" or "wrong-nonce" or "wrong-attempt" or "wrong-sha" or "wrong-host-creation" or "wrong-node-creation" or
            "half-ack" or "overlong-ack" or "eof" or "no-ack" or "stop-before-ack" or "ordinary" or "service-policy" or
            "post-authorize-disconnect",
            "startup_observation_case_unknown");
        Require(executionMs is >= 1500 and <= 30_000 && cleanupMs is > 0 and <= 15_000 &&
            Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any(),
            "startup_empty_owned_directory_and_bounded_budget_required");
        long cutoff = checked(Environment.TickCount64 + executionMs);
        using var overall = new CancellationTokenSource(checked(executionMs + cleanupMs));
        string attempt = Guid.NewGuid().ToString(), operation = Guid.NewGuid().ToString();
        string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        string pipeName = "zeb-worker-startup-v1-" + attempt.Replace("-", "");
        using var user = WindowsIdentity.GetCurrent();
        using var callerProcess = System.Diagnostics.Process.GetCurrentProcess();
        string sid = user.User?.Value ?? throw new InvalidDataException("startup_caller_sid_missing");
        var caller = Native.Identity(new IntPtr(-1));
        string context = JsonSerializer.Serialize(new
        {
            v = 1, operationId = operation, startupAttemptId = attempt, startingReceiptSha256 = StartupHash("starting-receipt"u8),
            pipeName, nonce, cutoffTick64 = cutoff,
            caller = new { caller.Pid, caller.CreationFileTime, imagePath = Executable,
                imageSha256 = StartupFileHash(Executable), tokenUserSid = sid, sessionId = callerProcess.Id == caller.Pid ?
                    callerProcess.SessionId : throw new InvalidDataException("startup_caller_changed") },
            expectedServiceSid = sid, inventorySha256 = StartupHash("technical-inventory"u8),
            configSha256 = StartupHash("technical-config"u8), engineManifestSha256 = StartupHash("technical-engine"u8),
            hostSha256 = StartupFileHash(Executable), nodeSha256 = StartupFileHash(node)
        }, Json);
        string encoded = Convert.ToBase64String(Utf8.GetBytes(context)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        if (scenario == "service-policy")
        {
            bool rejected = false;
            try { using var unexpected = StartupObservation.CreateForService(encoded); }
            catch (InvalidDataException) { rejected = true; }
            Require(rejected && !File.Exists(Path.Combine(directory, "root-starts.ndjson")),
                "production_factory_must_reject_technical_user_before_prepare");
            return WriteCase(directory, new { passed = true, scenario, technicalSameUser = true,
                scope = "negative production principal gate only; no SCM or production service token exercised" });
        }
        // Fixture-only server. The production caller must separately prove its two-SID ACL/native mask.
        using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance);
        var facts = new Dictionary<string, object?> { ["scenario"] = scenario, ["cutoffTick64"] = cutoff,
            ["contextSha256"] = StartupHash(Utf8.GetBytes(context)),
            ["technicalSameUser"] = true, ["crossSidScmAccepted"] = false };
        var failures = new List<string>();
        JobProcess? safety = null;
        ProcessPin? host = null, root = null;
        Task<StreamEnd>? outputDrain = null, errorDrain = null;
        StreamEnd? output = null, error = null;
        bool guardianUsed = false, originalsJoined = false, stopSent = false;
        string? preparedWire = null, submittedAckWire = null;
        try
        {
            safety = JobProcess.Prepare(Executable,
                ["startup-observation-host", directory, node, main, scenario == "ordinary" ? "ordinary" : encoded,
                    cutoff.ToString(CultureInfo.InvariantCulture), cleanupMs.ToString(CultureInfo.InvariantCulture)], directory);
            outputDrain = DrainAsync(safety.StandardOutput, capture: true);
            errorDrain = DrainAsync(safety.StandardError, capture: true);
            host = ProcessPin.OpenQualified(ToFact(safety.EngineIdentity), Executable, Native.FileIdentity(Executable), safety.JobName);
            Require(safety.AuthorizeOnce(), "startup_fixture_host_authorize_once");
            JsonElement? prepared = null;
            if (scenario != "ordinary")
            {
                using (var remaining = StartupRemaining(cutoff))
                    await pipe.WaitForConnectionAsync(remaining.Token);
                Native.Check(Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint peer), "startup_actual_pipe_client_pid");
                Require(peer == host.Identity.Pid && host.Alive, "startup_original_host_peer_required");
                var frame = await ReadStartupFrameAsync(pipe, 8192, cutoff);
                preparedWire = Convert.ToBase64String(frame.Raw);
                string preparedHash = StartupHash(frame.Raw);
                prepared = frame.Body;
                facts["prepared"] = prepared.Value;
                RequireStartupFrame(prepared.Value, "prepared", 1, nonce, operation, attempt);
                Require(prepared.Value.GetProperty("startingReceiptSha256").GetString() == StartupHash("starting-receipt"u8) &&
                    prepared.Value.GetProperty("inventorySha256").GetString() == StartupHash("technical-inventory"u8) &&
                    prepared.Value.GetProperty("configSha256").GetString() == StartupHash("technical-config"u8) &&
                    prepared.Value.GetProperty("engineManifestSha256").GetString() == StartupHash("technical-engine"u8) &&
                    prepared.Value.GetProperty("hostSha256").GetString() == StartupFileHash(Executable) &&
                    prepared.Value.GetProperty("nodeSha256").GetString() == StartupFileHash(node), "startup_frozen_material_echo");
                Require(prepared.Value.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity, "startup_prepared_original_host");
                var identity = prepared.Value.GetProperty("node").Deserialize<ProcessFact>(Json) ??
                    throw new InvalidDataException("startup_prepared_node_identity_missing");
                string jobName = prepared.Value.GetProperty("jobName").GetString() ?? throw new InvalidDataException("startup_job_name_missing");
                root = ProcessPin.OpenQualified(identity, node, Native.FileIdentity(node), jobName);
                var inspection = prepared.Value.GetProperty("inspection");
                RequireStartupKeys(inspection, ["processSignaled", "inOriginalJob", "activeProcesses", "totalProcesses",
                    "jobHandleFlags", "processHandleFlags", "authorized", "sealed"]);
                Require(!inspection.GetProperty("authorized").GetBoolean() && !inspection.GetProperty("sealed").GetBoolean() &&
                    !inspection.GetProperty("processSignaled").GetBoolean() && inspection.GetProperty("inOriginalJob").GetBoolean() &&
                    inspection.GetProperty("activeProcesses").GetUInt32() >= 1 &&
                    inspection.GetProperty("totalProcesses").GetUInt32() >= inspection.GetProperty("activeProcesses").GetUInt32() &&
                    (inspection.GetProperty("jobHandleFlags").GetUInt32() & 1) == 0 &&
                    (inspection.GetProperty("processHandleFlags").GetUInt32() & 1) == 0, "startup_actual_original_prepared_inspection");
                await Task.Delay(150, overall.Token);
                Require(host.Alive && root.Alive && !File.Exists(Path.Combine(directory, "root-starts.ndjson")) &&
                    !File.Exists(Path.Combine(directory, "startup-start-returned.json")), "behavior_red_node_must_not_resume_before_ack");
                await safety.StandardInput.WriteAsync("inspect\n"u8.ToArray(), overall.Token);
                await safety.StandardInput.FlushAsync(overall.Token);
                var heldInspection = await WaitStartupMarkerAsync(directory, "startup-before-ack-inspect.json", overall.Token);
                Require(heldInspection.GetProperty("root").Deserialize<ProcessFact>(Json) == root.Identity &&
                    heldInspection.GetProperty("jobName").GetString() == jobName &&
                    !heldInspection.GetProperty("authorized").GetBoolean() && !heldInspection.GetProperty("sealed").GetBoolean() &&
                    !heldInspection.GetProperty("processSignaled").GetBoolean() &&
                    heldInspection.GetProperty("inOriginalJob").GetBoolean() &&
                    !File.Exists(Path.Combine(directory, "root-starts.ndjson")), "behavior_red_live_owner_must_still_be_prepared_before_ack");
                facts["beforeAck"] = new { inspection, heldInspection, host = host.Evidence(), node = root.Evidence(),
                    markerAbsent = true, preparedSha256 = preparedHash, observedTick = Environment.TickCount64 };
                var ack = new Dictionary<string, object?>
                {
                    ["v"] = 1, ["kind"] = "ack_prepared", ["seq"] = 2, ["nonce"] = nonce,
                    ["operationId"] = operation, ["startupAttemptId"] = attempt, ["preparedSha256"] = preparedHash,
                    ["host"] = prepared.Value.GetProperty("host"), ["node"] = prepared.Value.GetProperty("node")
                };
                if (scenario == "wrong-nonce") ack["nonce"] = (nonce[0] == '0' ? "1" : "0") + nonce[1..];
                if (scenario == "wrong-attempt") ack["startupAttemptId"] = Guid.NewGuid().ToString();
                if (scenario == "wrong-sha") ack["preparedSha256"] = (preparedHash[0] == '0' ? "1" : "0") + preparedHash[1..];
                if (scenario == "wrong-host-creation") ack["host"] = new { pid = host.Identity.Pid,
                    creationFileTime = checked(ulong.Parse(host.Identity.CreationFileTime, CultureInfo.InvariantCulture) + 1).ToString(CultureInfo.InvariantCulture) };
                if (scenario == "wrong-node-creation") ack["node"] = new { pid = root.Identity.Pid,
                    creationFileTime = checked(ulong.Parse(root.Identity.CreationFileTime, CultureInfo.InvariantCulture) + 1).ToString(CultureInfo.InvariantCulture) };
                if (scenario == "stop-before-ack")
                {
                    await SendStartupStopAsync(safety, overall.Token); stopSent = true;
                    await WaitStartupMarkerAsync(directory, "startup-stop-sealed.json", overall.Token);
                }
                if (scenario == "eof") pipe.Dispose();
                else if (scenario != "no-ack")
                {
                    byte[] rawAck = StartupFrame(ack);
                    submittedAckWire = Convert.ToBase64String(rawAck);
                    try
                    {
                        byte[] written = scenario == "overlong-ack" ? new byte[] { 1, 4, 0, 0 } :
                            scenario == "half-ack" ? rawAck[..(rawAck.Length / 2)] : rawAck;
                        if (scenario == "overlong-ack") await pipe.WriteAsync(written, overall.Token);
                        else if (scenario == "half-ack")
                        {
                            await pipe.WriteAsync(written, overall.Token);
                            pipe.Dispose();
                        }
                        else if (scenario == "post-authorize-disconnect")
                        {
                            // Narrow the real race; capture below must prove which side actually won it.
                            await pipe.WriteAsync(written.AsMemory(0, written.Length - 1), overall.Token);
                            await pipe.WriteAsync(written.AsMemory(written.Length - 1), overall.Token);
                            pipe.Dispose();
                        }
                        else await pipe.WriteAsync(written, overall.Token);
                        facts["ackWrite"] = new { bytesWritten = written.Length, wireSha256 = StartupHash(written), tick = Environment.TickCount64 };
                    }
                    catch (IOException) when (scenario == "stop-before-ack") { }
                }
                if (scenario == "ack")
                {
                    var authorized = (await ReadStartupFrameAsync(pipe, 1024, cutoff)).Body;
                    RequireStartupFrame(authorized, "authorized", 3, nonce, operation, attempt);
                    Require(authorized.GetProperty("authorized").GetBoolean() &&
                        authorized.GetProperty("preparedSha256").GetString() == preparedHash &&
                        authorized.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity &&
                        authorized.GetProperty("node").Deserialize<ProcessFact>(Json) == root.Identity,
                        "behavior_red_correct_ack_must_authorize_original_once");
                    facts["authorized"] = authorized;
                }
            }
            var returned = await WaitStartupMarkerAsync(directory, "startup-start-returned.json", overall.Token);
            bool shouldRun = scenario is "ack" or "ordinary" or "post-authorize-disconnect";
            if (scenario == "post-authorize-disconnect")
            {
                var observedRoot = root ?? throw new InvalidDataException("startup_original_node_pin_missing");
                facts["startReturned"] = returned;
                facts["disconnectRaceTargetReached"] = false;
                var capture = returned.GetProperty("capture");
                Require(returned.GetProperty("startFailureType").GetString() == "IOException" &&
                    capture.GetProperty("failureType").GetString() == "IOException" &&
                    capture.GetProperty("firstFailureRetained").GetBoolean() &&
                    capture.GetProperty("failureStage").GetString() == "write-authorized" &&
                    capture.GetProperty("stage").GetString() == "write-authorized" &&
                    capture.GetProperty("preparedWriteReturned").GetBoolean() && capture.GetProperty("ackValidated").GetBoolean() &&
                    capture.GetProperty("authorizationMayHaveOccurred").GetBoolean() &&
                    !capture.GetProperty("authorizedWriteReturned").GetBoolean(),
                    "startup_disconnect_race_target_not_reached_no_post_authorize_failure_proof");
                Require(capture.GetProperty("contextSha256").GetString() == (string?)facts["contextSha256"] &&
                    capture.GetProperty("preparedFrameBase64").GetString() == preparedWire &&
                    capture.GetProperty("ackFrameBase64").GetString() == submittedAckWire,
                    "startup_post_authorize_original_capture_binding");
                using var capturedAuthorized = new MemoryStream(Convert.FromBase64String(
                    capture.GetProperty("authorizedFrameBase64").GetString() ?? throw new InvalidDataException("startup_authorized_source_missing")));
                var attempted = (await ReadStartupFrameAsync(capturedAuthorized, 1024, cutoff)).Body;
                RequireStartupFrame(attempted, "authorized", 3, nonce, operation, attempt);
                Require(capturedAuthorized.Position == capturedAuthorized.Length && attempted.GetProperty("authorized").GetBoolean() &&
                    attempted.GetProperty("preparedSha256").GetString() == StartupHash(Convert.FromBase64String(preparedWire!)) &&
                    attempted.GetProperty("host").Deserialize<ProcessFact>(Json) == host.Identity &&
                    attempted.GetProperty("node").Deserialize<ProcessFact>(Json) == observedRoot.Identity,
                    "startup_post_authorize_attempted_frame_is_original_not_received_proof");
                facts["disconnectRaceTargetReached"] = true;
                // The preceding synchronous append has closed before this marker is created.
                while (!File.Exists(Path.Combine(directory, "root-first-action-complete"))) await Task.Delay(5, overall.Token);
                Require(RootStarts(directory) == 1, "startup_exact_completed_first_action");
                Require(host.Alive && observedRoot.Alive && !stopSent &&
                    !returned.GetProperty("completionBeforeExplicitStop").GetBoolean() &&
                    !File.Exists(Path.Combine(directory, "startup-stop-sealed.json")),
                    "startup_observation_failure_must_not_kill_original_before_explicit_stop");
                facts["postAuthorizationAlive"] = new { host = host.Evidence(), node = observedRoot.Evidence(),
                    workerStarts = RootStarts(directory), beforeExplicitStop = true, tick = Environment.TickCount64 };
            }
            else if (shouldRun)
            {
                Require(returned.GetProperty("startFailureType").ValueKind == JsonValueKind.Null, "startup_positive_start_failed");
                while (!File.Exists(Path.Combine(directory, "root-first-action-complete"))) await Task.Delay(5, overall.Token);
                Require(RootStarts(directory) == 1, "startup_exact_completed_first_action");
                Require(host.Alive && (root is null || root.Alive), "startup_positive_original_still_live");
            }
            else
            {
                Require(!File.Exists(Path.Combine(directory, "root-starts.ndjson")), "behavior_red_invalid_or_missing_ack_resumed_node");
                if (scenario != "stop-before-ack")
                    Require(returned.GetProperty("startFailureType").ValueKind == JsonValueKind.String, "startup_observation_rejection_must_not_fall_back");
                if (scenario == "no-ack")
                    Require(Environment.TickCount64 >= cutoff, "startup_missing_ack_must_observe_original_cutoff");
            }
            facts["startReturned"] = returned;
            if (!stopSent) { await SendStartupStopAsync(safety, overall.Token); stopSent = true; }
            await host.JoinAsync(overall.Token);
            if (root is not null) await root.JoinAsync(overall.Token);
            var tree = await safety.WaitForTreeExitAsync().WaitAsync(overall.Token);
            output = await outputDrain.WaitAsync(overall.Token); error = await errorDrain.WaitAsync(overall.Token);
            Require(tree.ActiveProcesses == 0 && output.Eof && error.Eof && output.ErrorType is null && error.ErrorType is null,
                "startup_original_fixture_tree_and_dual_eof");
            using var childDocument = JsonDocument.Parse(Utf8.GetString(Convert.FromBase64String(output.Utf8Base64!)));
            var child = childDocument.RootElement.Clone();
            Require(child.GetProperty("physicalCleanup").GetBoolean() && child.GetProperty("secondStartRejected").GetBoolean(),
                "startup_same_original_cleanup_and_no_second_generation");
            Require(RootStarts(directory) == (shouldRun ? 1 : 0), "startup_exact_first_action_count");
            if (scenario != "ordinary" && scenario is not "eof" and not "half-ack" and not "post-authorize-disconnect")
            {
                byte[] end = new byte[1];
                Require(await pipe.ReadAsync(end, overall.Token) == 0, "startup_no_extra_authorization_frame_and_actual_pipe_eof");
            }
            originalsJoined = true;
            facts["completed"] = child; facts["safetyTree"] = tree;
            facts["hostPin"] = host.Evidence(); facts["nodePin"] = root?.Evidence();
            facts["hostStdout"] = output; facts["hostStderr"] = error;
        }
        catch (Exception failure) { failures.Add(failure.GetType().Name + ": " + failure.Message); }
        finally
        {
            if (!originalsJoined && safety is not null)
            {
                guardianUsed = true;
                using var cleanup = new CancellationTokenSource(cleanupMs);
                try
                {
                    safety.Force();
                    await safety.WaitForTreeExitAsync().WaitAsync(cleanup.Token);
                    if (host is not null) await host.JoinAsync(cleanup.Token);
                    if (root is not null) await root.JoinAsync(cleanup.Token);
                    if (outputDrain is not null) output = await outputDrain.WaitAsync(cleanup.Token);
                    if (errorDrain is not null) error = await errorDrain.WaitAsync(cleanup.Token);
                }
                catch (Exception failure) { failures.Add("guardian:" + failure.GetType().Name); }
            }
            root?.Dispose(); host?.Dispose(); safety?.Dispose();
        }
        facts["guardianUsed"] = guardianUsed; facts["originalsJoined"] = originalsJoined;
        facts["failures"] = failures; facts["passed"] = failures.Count == 0 && !guardianUsed && originalsJoined;
        facts["scope"] = "technical original Host/Node Prepared-ACK gate only; no SCM OnStart, production cross-SID ACL, Node phase, FailureProof or Recover acceptance";
        return WriteCase(directory, facts);
    }

    private static async Task<int> RunStartupObservationHostAsync(string[] args)
    {
        string directory = args[1], node = args[2], main = args[3], context = args[4];
        long cutoff = long.Parse(args[5], CultureInfo.InvariantCulture);
        int cleanupMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(1, cutoff - Environment.TickCount64 + cleanupMs)));
        using var rawOut = new FileStream(Path.Combine(directory, "startup-worker.stdout.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var rawErr = new FileStream(Path.Combine(directory, "startup-worker.stderr.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var session = new ContainedWorkerSession(node, [main, directory], directory, bytes => rawOut.Write(bytes.Span), bytes => rawErr.Write(bytes.Span));
        using var observation = context == "ordinary" ? null : StartupObservation.CreateForTechnicalFixture(context);
        string? startFailureType = null, completionFailureType = null;
        Exception? startFailure = null;
        Task start = Task.Run(() =>
        {
            try { if (observation is null) session.Start(); else session.Start(observation); }
            catch (Exception failure) { startFailure = failure; startFailureType = failure.GetType().Name; }
            finally
            {
                PublishStartupMarker(directory, "startup-start-returned.json", new { startFailureType,
                    capture = StartupCaptureFacts(observation, startFailure), completionBeforeExplicitStop = session.Completion.IsCompleted,
                    tick = Environment.TickCount64 });
            }
        });
        Task stop = Task.Run(async () =>
        {
            string? command = await Console.In.ReadLineAsync(cleanup.Token);
            if (command == "inspect")
            {
                var actual = session.Inspect() ?? throw new InvalidDataException("startup_held_original_owner_missing");
                PublishStartupMarker(directory, "startup-before-ack-inspect.json", new { root = ToFact(actual.EngineIdentity),
                    jobName = session.JobName, actual.Authorized, actual.Sealed, actual.ProcessSignaled, actual.InOriginalJob,
                    actual.ActiveProcesses, actual.TotalProcesses, actual.JobHandleFlags, actual.ProcessHandleFlags });
                command = await Console.In.ReadLineAsync(cleanup.Token);
            }
            Require(command == "stop", "startup_explicit_fixture_stop_required");
            Task original = session.StopAsync();
            PublishStartupMarker(directory, "startup-stop-sealed.json", new { tick = Environment.TickCount64 });
            try { await original.WaitAsync(cleanup.Token); } catch (Exception) when (original.IsFaulted) { }
        });
        await start.WaitAsync(cleanup.Token);
        await stop.WaitAsync(cleanup.Token);
        try { await session.Completion.WaitAsync(cleanup.Token); }
        catch (Exception failure) when (session.Completion.IsFaulted) { completionFailureType = failure.GetType().Name; }
        bool secondStartRejected = false;
        try { session.Start(); } catch (InvalidOperationException) { secondStartRejected = true; }
        var actual = session.CleanupObservation;
        bool physicalCleanup = actual.RootExit is not null && actual.TreeExit?.ActiveProcesses == 0 &&
            actual.Stdout.Eof && actual.Stderr.Eof && actual.Stdout.ReadFailureType is null && actual.Stderr.ReadFailureType is null &&
            actual.Stdout.SinkFailureType is null && actual.Stderr.SinkFailureType is null;
        Console.WriteLine(JsonSerializer.Serialize(new { physicalCleanup, secondStartRejected, startFailureType,
            completionFailureType, cleanup = CleanupFacts(actual), graceful = session.GracefulObservation,
            workerStarts = RootStarts(directory), technicalSameUser = true }, Json));
        return physicalCleanup && secondStartRejected ? 0 : 1;
    }

    private static object? StartupCaptureFacts(StartupObservation? observation, Exception? startFailure)
    {
        if (observation is null) return null;
        var capture = observation.Capture;
        return new { capture.ContextSha256, capture.Stage, capture.FailureStage,
            failureType = capture.Failure?.GetType().Name,
            firstFailureRetained = startFailure is not null && ReferenceEquals(capture.Failure, startFailure),
            capture.PreparedFrameBase64, capture.PreparedWriteReturned, capture.AckFrameBase64, capture.AckValidated,
            capture.AuthorizedFrameBase64, capture.AuthorizedWriteReturned, capture.AuthorizationMayHaveOccurred };
    }

    private static string StartupFileHash(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
    }
    private static string StartupHash(ReadOnlySpan<byte> bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static CancellationTokenSource StartupRemaining(long cutoff) =>
        new(TimeSpan.FromMilliseconds(Math.Max(1, cutoff - Environment.TickCount64)));
    private static byte[] StartupFrame(object value)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(value, Json), raw = new byte[4 + body.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(raw, checked((uint)body.Length));
        body.CopyTo(raw, 4); return raw;
    }
    private static async Task<(JsonElement Body, byte[] Raw)> ReadStartupFrameAsync(Stream pipe, int maximum, long cutoff)
    {
        using var remaining = StartupRemaining(cutoff);
        byte[] header = new byte[4]; await pipe.ReadExactlyAsync(header, remaining.Token);
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        Require(length > 0 && length <= maximum && Environment.TickCount64 < cutoff, "startup_frame_original_budget");
        byte[] body = new byte[checked((int)length)]; await pipe.ReadExactlyAsync(body, remaining.Token);
        string text = Utf8.GetString(body);
        using var parsed = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
        Require(parsed.RootElement.ValueKind == JsonValueKind.Object, "startup_frame_object_required");
        RejectStartupDuplicateKeys(parsed.RootElement);
        byte[] raw = new byte[4 + body.Length]; header.CopyTo(raw, 0); body.CopyTo(raw, 4);
        return (parsed.RootElement.Clone(), raw);
    }
    private static void RejectStartupDuplicateKeys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                Require(names.Add(property.Name), "startup_frame_duplicate_key");
                RejectStartupDuplicateKeys(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var child in value.EnumerateArray()) RejectStartupDuplicateKeys(child);
    }
    private static void RequireStartupFrame(JsonElement value, string kind, int sequence, string nonce, string operation, string attempt)
    {
        RequireStartupKeys(value, kind == "prepared" ?
            ["v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "startingReceiptSha256", "host", "node", "jobName",
                "inventorySha256", "configSha256", "engineManifestSha256", "hostSha256", "nodeSha256", "inspection"] :
            ["v", "kind", "seq", "nonce", "operationId", "startupAttemptId", "preparedSha256", "host", "node", "authorized"]);
        foreach (string principal in new[] { "host", "node" })
        {
            var identity = value.GetProperty(principal);
            RequireStartupKeys(identity, ["pid", "creationFileTime"]);
            string? creation = identity.GetProperty("creationFileTime").GetString();
            Require(identity.GetProperty("pid").GetInt32() > 0 &&
                ulong.TryParse(creation, NumberStyles.None, CultureInfo.InvariantCulture, out ulong parsed) && parsed > 0 &&
                parsed.ToString(CultureInfo.InvariantCulture) == creation, "startup_canonical_process_identity");
        }
        Require(value.GetProperty("v").GetInt32() == 1 && value.GetProperty("kind").GetString() == kind &&
            value.GetProperty("seq").GetInt32() == sequence && value.GetProperty("nonce").GetString() == nonce &&
            value.GetProperty("operationId").GetString() == operation && value.GetProperty("startupAttemptId").GetString() == attempt,
            "startup_frame_original_binding_and_order");
    }
    private static void RequireStartupKeys(JsonElement value, string[] expected)
    {
        Require(value.ValueKind == JsonValueKind.Object &&
            value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal)
                .SequenceEqual(expected.Order(StringComparer.Ordinal)), "startup_frame_unknown_or_missing_key");
    }
    private static async Task<JsonElement> WaitStartupMarkerAsync(string directory, string name, CancellationToken token)
    {
        string path = Path.Combine(directory, name);
        while (!File.Exists(path)) await Task.Delay(5, token);
        using var document = JsonDocument.Parse(File.ReadAllBytes(path)); return document.RootElement.Clone();
    }
    private static void PublishStartupMarker(string directory, string name, object value)
    {
        string path = Path.Combine(directory, name), temporary = path + ".tmp";
        WriteNew(temporary, value); File.Move(temporary, path);
    }
    private static async Task SendStartupStopAsync(JobProcess safety, CancellationToken token)
    {
        await safety.StandardInput.WriteAsync("stop\n"u8.ToArray(), token);
        await safety.StandardInput.FlushAsync(token);
    }
}
