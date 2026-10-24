using System.Text.Json;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsSessionFixture;

// Uses the already assigned outer guardian; the product bridge creates the only helper.
internal static class ExecutionBridgeHarness
{
    internal static async Task<int> RunAsync(string bridge, string ordinary, string fault,
        string directory, long deadlineTick, int cleanupMs, string scenario, Frames commands, Task inputTask)
    {
        using var execution = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, deadlineTick - Environment.TickCount64)));
        var values = new Dictionary<string, object?>();
        var cleanupFailures = new List<object>();
        object? setupFailure = null, failure = null;
        RunContext? run = null;
        Child? child = null;
        ProcessPin? helper = null;
        ProcessPin? bridgeQuery = null;
        ProcessPin? reader = null;
        var readerStages = new List<object>();
        bool readerPinEnabled = Program.ReaderPinEnabled;
        Bridge? faultBarrier = null;
        Bridge? stopAckBarrier = null;
        PrepareDiagnosticScenarios.Fault? prepareFault = null;
        bool workerDiagnostic = scenario == "execution-node-worker-prepare-installation-denied";
        bool prepareDenied = workerDiagnostic || scenario == "execution-node-prepare-installation-denied";
        bool nodeStop = scenario.StartsWith("execution-node-stop-", StringComparison.Ordinal);
        bool heldStop = nodeStop && scenario != "execution-node-stop-soft";
        var frames = new Frames();
        string? callerDeathStage = scenario switch
        {
            "execution-node-caller-death-never-prepare" => "never-prepare",
            "execution-node-caller-death-prepared" => "prepared",
            "execution-node-caller-death-running" => "running",
            _ => null,
        };
        bool callerDeathEngineJoins = false;
        string? readerLossStage = scenario switch
        {
            "execution-node-reader-loss-before-input" => "before-input",
            "execution-node-reader-loss-after-input" => "after-input",
            _ => null,
        };
        bool readerLossEngineJoins = false;
        bool rawInterleaving = scenario is "execution-permit-close" or "execution-permit-eof" or "execution-permit-replay" or "execution-natural-close-id" or "execution-stop-wire";
        bool rawEngineJoins = false;
        const string prepareId = "00000000000000000000000000000007";
        const string closeId = "00000000000000000000000000000008";
        const string authorizeId = "00000000000000000000000000000009";
        const string stopId = "0000000000000000000000000000000a";
        try
        {
            bool nodeScenario = scenario.StartsWith("execution-node-", StringComparison.Ordinal);
            Program.Require(!readerPinEnabled || scenario is "execution-node-natural" or "execution-node-stop-soft" or
                "execution-node-reader-loss-before-input" or "execution-node-reader-loss-after-input", "reader_pin_adapter_scenario_only");
            Program.Require(readerLossStage is null || readerPinEnabled, "reader_loss_original_registration_required");
            Program.Require(scenario is "execution-prepare" or "execution-permit-close" or "execution-permit-eof" or "execution-permit-replay" or
                "execution-natural-close-id" or "execution-stop-wire" or "execution-node-natural" or "execution-node-fast" or "execution-node-nonzero" or
                "execution-node-deny-auth" or "execution-node-missing-ack" or "execution-node-held-drain" or
                "execution-node-caller-death-never-prepare" or "execution-node-caller-death-prepared" or "execution-node-caller-death-running" or
                "execution-node-reader-loss-before-input" or "execution-node-reader-loss-after-input" or
                "execution-node-stop-soft" or "execution-node-stop-held" or "execution-node-stop-missing-ack" or
                "execution-node-prepare-installation-denied" or "execution-node-worker-prepare-installation-denied", "execution_bridge_scenario");
            Program.Require(new[] { bridge, ordinary, fault }.All(path => Path.IsPathFullyQualified(path) && File.Exists(path)), "execution_bridge_fixed_artifacts");
            run = new RunContext(scenario, directory, ordinary, fault,
                Path.Combine(Path.GetDirectoryName(ordinary)!, "WindowsSupervisor.dll"), deadlineTick, commands);
            await run.MetadataAsync(checked((int)Math.Max(1, deadlineTick - Environment.TickCount64)), cleanupMs, execution.Token);
            // Parse the supplied original bytes; never rebuild a second carrier in the fixture.
            var parsed = PreparePayload.Parse(Program.Text(run.Carrier, "requestUtf8Base64"), Program.Text(run.Carrier, "requestFingerprint"));
            Program.Require(parsed.Scope == run.Scope, "execution_bridge_original_carrier_scope");
            values["carrier"] = run.Carrier;
            values["manifestSha256"] = run.Bundle.ManifestSha256;
            values["publishFiles"] = run.Bundle.PublishFiles;
            var environment = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var key in new[] { "SystemRoot", "WINDIR", "TEMP", "TMP" })
                if (Environment.GetEnvironmentVariable(key) is { } value) environment.Add(key, value);
            bool faultScenario = scenario is "execution-node-missing-ack" or "execution-node-held-drain" || heldStop;
            if (faultScenario)
            {
                long fixtureDeadlineUnixMs = checked(Program.Now + Math.Max(0, deadlineTick - Environment.TickCount64));
                faultBarrier = heldStop ? new Bridge(new("terminal", "BeforeForce", "None"), fixtureDeadlineUnixMs) : new Bridge(scenario == "execution-node-missing-ack"
                    ? new("auth", "AfterResumeBeforeAck", "None") : new("prepared", "BeforeDrainRead", "None"));
                environment.Add("ZEB_NATIVE_SESSION_TEST_BRIDGE", faultBarrier.Configuration.GetRawText());
                if (heldStop)
                {
                    stopAckBarrier = new Bridge(new("stop", "StopBeforeAck", "None"), fixtureDeadlineUnixMs);
                    environment.Add("ZEB_NATIVE_STOP_ACK_TEST_BRIDGE", stopAckBarrier.Configuration.GetRawText());
                    values["stopTestGateBudget"] = new { source = "original-outer-fixture-execution-deadline", fixtureDeadlineUnixMs, deadlineTick };
                }
            }
            // Existing explicit control-bridge fixture policy, not production defaults.
            var config = new
            {
                v = 1, helperPath = faultScenario ? fault : ordinary, recordsRoot = run.RecordsRoot,
                installationRoot = run.Bundle.Root, expectedManifestSha256 = run.Bundle.ManifestSha256,
                environment,
                limits = new
                {
                    maxRequestFrameBytes = 65536, maxResponseFrameBytes = 65536, maxHelperStderrBytes = 8192,
                    maxSessionInputBytes = 262144, maxSessionOutputBytes = 1048576, maxQueuedOutputBytes = 262144,
                    maxJsonDepth = 16, startupTimeoutMs = 8000, requestTimeoutMs = 5000,
                    sessionTimeoutMs = 45000, cleanupTimeoutMs = 5000,
                },
            };
            values["configuration"] = config;
            if (prepareDenied)
            {
                prepareFault = new PrepareDiagnosticScenarios.Fault(run, false);
                values["prepareDiagnosticFault"] = prepareFault.Trace;
            }
            if (nodeScenario)
            {
                string RequiredPath(string key)
                {
                    string path = Environment.GetEnvironmentVariable(key) ?? throw new InvalidDataException("execution_node_fixed_path_missing");
                    Program.Require(Path.IsPathFullyQualified(path) && File.Exists(path), "execution_node_fixed_path");
                    return path;
                }
                string node = RequiredPath("ZEB_WINDOWS_EXECUTION_NODE_EXE"), runner = RequiredPath("ZEB_WINDOWS_EXECUTION_NODE_RUNNER"),
                    hostModule = RequiredPath("ZEB_WINDOWS_EXECUTION_HOST_MODULE");
                string nodeConfig = Path.Combine(directory, "node-host.json");
                Probe.CreateFile(nodeConfig, JsonSerializer.SerializeToUtf8Bytes(new
                {
                    scenario, hostModule, marker = run.Marker, options = new { executablePath = bridge, config.helperPath, config.recordsRoot, config.installationRoot,
                        config.expectedManifestSha256, config.environment, config.limits }, request = run.Carrier,
                    expected = new { target = run.Scope.Target, executionPolicyFingerprint = run.Scope.ExecutionPolicyFingerprint },
                    workerInputPath = workerDiagnostic ? Path.Combine(directory, "worker-diagnostic-input.json") : null,
                }, Program.Json));
                child = new Child(node, directory, runner, nodeConfig);
                child.SetTestEnvironment("ZEB_WINDOWS_EXECUTION_ADAPTER_READER_PIN", readerPinEnabled ? "1" : "0");
                values["nodeRunner"] = new { node, runner, hostModule, runnerSha256 = Program.Hash(File.ReadAllBytes(runner)), hostModuleSha256 = Program.Hash(File.ReadAllBytes(hostModule)) };
            }
            else child = new Child(bridge, directory, "--control-bridge", JsonSerializer.Serialize(config, Program.Json));
            child.StartRaw(bytes =>
            {
                Program.Require(bytes.Length > 1 && bytes[^1] == (byte)'\n' && !bytes.Contains((byte)'\r'), "execution_bridge_exact_raw_frame");
                frames.Add(Program.Parse(Program.Utf8.GetString(bytes)));
            });
            _ = child.RawOutput!.Completion.ContinueWith(_ => frames.End(child.RawOutput.Error is null ? null : new InvalidDataException(child.RawOutput.Error)), TaskScheduler.Default);
            await run.RegisterAsync(child.Pin!, execution.Token);
            var boundFrame = await frames.MatchAsync(frame => Program.Text(frame, "kind") == (nodeScenario ? "node-bound" : "bound") ||
                Program.Text(frame, "kind") is "unknown" or "node-result", execution.Token);
            var bound = nodeScenario ? boundFrame.GetProperty("binding") : boundFrame;
            values["bound"] = bound;
            if (nodeScenario)
            {
                Program.Exact(bound, "executionId", "bridge", "helper", "state");
                var bridgeFact = bound.GetProperty("bridge").Deserialize<ProcessFact>(Program.Json)!;
                bridgeQuery = ProcessPin.Open(bridgeFact.Pid);
                Program.Require(bridgeQuery.Identity == bridgeFact && bridgeQuery.Alive, "execution_node_bridge_exact_query");
                await run.RegisterAsync(bridgeQuery, execution.Token);
                values["bridgeEvidenceSource"] = "original-node-spawn-observation-plus-exact-identity-query";
            }
            else
            {
                Program.Require(Program.Text(bound, "kind") == "bound", "execution_bridge_actual_bound_required");
                Program.Exact(bound, "v", "kind", "executionId", "bridge", "helper", "state");
                Program.Require(bound.GetProperty("bridge").Deserialize<ProcessFact>(Program.Json) == child.Pin!.Identity, "execution_bridge_original_creation_pin");
            }
            var helperFact = bound.GetProperty("helper").Deserialize<ProcessFact>(Program.Json)!;
            helper = ProcessPin.Open(helperFact.Pid);
            Program.Require(helper.Identity == helperFact && helper.Alive, "execution_bridge_bound_helper_exact_query");
            await run.RegisterAsync(helper, execution.Token);
            values["helperEvidenceSource"] = "trusted-product-bridge-statement-plus-exact-identity-query";
            var executionId = Program.Text(bound, "executionId");
            if (nodeScenario)
            {
                if (prepareDenied)
                {
                    values["prepareDiagnosticSendBarrier"] = new { originalBridgeRegistered = bridgeQuery is not null,
                        originalHelperRegistered = true, originalHelperLive = helper.Alive, executionId };
                    await child.SendRawAsync(new { command = "begin-prepare" }, execution.Token);
                }
                faultBarrier?.Bind(helper.Identity);
                faultBarrier?.BindExecution(executionId, parsed.RequestFingerprint);
                stopAckBarrier?.Bind(helper.Identity);
                stopAckBarrier?.BindExecution(executionId, parsed.RequestFingerprint);
                if (callerDeathStage == "never-prepare")
                {
                    await InjectCallerDeathAsync(callerDeathStage, frames, run, child, bridgeQuery!, helper, bound, null, null, values, execution.Token);
                }
                else
                {
                    var prepared = await frames.MatchAsync(frame => Program.Text(frame, "kind") is "node-prepared" or "node-result", execution.Token);
                    values["nodePrepared"] = prepared;
                    if (prepareDenied)
                    {
                        if (workerDiagnostic)
                        {
                            var maintenance = prepared.GetProperty("maintenance").GetProperty("body").GetProperty("data");
                            Program.Require(maintenance.GetProperty("store").GetProperty("slots").GetInt32() == 1 &&
                                Program.Text(maintenance.GetProperty("runtime").GetProperty("runner"), "ownedState") == "unknown",
                                "execution_worker_prepare_denial_keeps_slot");
                        }
                        else Program.Require(Program.Text(prepared.GetProperty("result"), "kind") == "unknown", "execution_prepare_denial_keeps_unknown");
                        prepareFault!.Restore();
                        await helper.WaitAsync(execution.Token);
                        Program.Require(helper.Joined && helper.ExitCode == 2 && bridgeQuery!.Alive && !File.Exists(run.Marker) &&
                            run.EnginePins.Count == 0 && Directory.GetFileSystemEntries(run.RecordsRoot).Length == 0,
                            "execution_prepare_denial_original_retained_no_engine");
                        values["prepareDiagnosticBeforeContainment"] = new { resultObservedBeforeContainment = true,
                            originalHelper = helper.Identity, helperNaturalExitCode = helper.ExitCode, helperJoined = helper.Joined,
                            originalBridge = bridgeQuery!.Identity, originalBridgeRetainedLive = true, engineCreated = false,
                            recordsEmpty = true, productCleanupQualified = false };
                        // Test-only containment of the exact retained bridge after its real result, never a product cleanup proof.
                        bridgeQuery.Terminate();
                        await bridgeQuery.WaitAsync(execution.Token);
                        var result = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-result", execution.Token);
                        values["nodeResult"] = result;
                        Program.Require(!result.TryGetProperty("failure", out _), "execution_prepare_denial_node_failed");
                        values["explicitOriginalBridgeContainment"] = true;
                        values["bridgeLaunches"] = result.GetProperty("factsAtReturn").GetProperty("spawnCount").GetInt32();
                    }
                    else
                    {
                    Program.Require(Program.Text(prepared.GetProperty("result"), "kind") == "prepared", "execution_node_prepared_required");
                    var descriptor = prepared.GetProperty("result").GetProperty("descriptor").Clone();
                    values["descriptor"] = descriptor;
                    run.PinDescriptor(descriptor);
                    var engine = run.PinFact(descriptor.GetProperty("details").GetProperty("engine"));
                    await run.RegisterAsync(engine, execution.Token);
                    faultBarrier?.BindPrepared(descriptor);
                    stopAckBarrier?.BindPrepared(descriptor);
                    if (callerDeathStage is not null)
                    {
                        if (callerDeathStage == "prepared") values["preparedBeforeCallerDeath"] = run.PreparedProbe(descriptor);
                        else
                        {
                            var authorized = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-authorize-result", execution.Token);
                            Program.Require(Program.Text(authorized.GetProperty("result"), "kind") == "authorized", "caller_death_real_auth_ack_required");
                            values["authAckBeforeCallerDeath"] = authorized;
                            var peer = await run.PeerAsync("engine", descriptor, execution.Token);
                            var markerIdentity = Program.Parse(Program.Utf8.GetString(File.ReadAllBytes(run.Marker))).Deserialize<ProcessFact>(Program.Json);
                            Program.Require(peer.Pin.Identity == engine.Identity && markerIdentity == engine.Identity && engine.Alive, "caller_death_original_running_engine");
                            values["runningBeforeCallerDeath"] = new { engine = engine.Identity, peer = peer.Pin.Identity, markerIdentity, originalEngineLive = engine.Alive };
                        }
                        await InjectCallerDeathAsync(callerDeathStage, frames, run, child, bridgeQuery!, helper, bound, descriptor, engine, values, execution.Token);
                    }
                    else
                    {
                        if (nodeStop)
                        {
                            var authorized = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-authorize-result", execution.Token);
                            Program.Require(Program.Text(authorized.GetProperty("result"), "kind") == "authorized", "execution_stop_original_auth_ack_required");
                            values["authAckBeforeStop"] = authorized;
                            var peer = await run.PeerAsync("engine", descriptor, execution.Token);
                            Program.Require(peer.Pin.Identity == engine.Identity && engine.Alive, "execution_stop_original_running_engine");
                            run.CloseJobHandles();
                            await child.SendRawAsync(new { command = "request-soft" }, execution.Token);
                            var sent = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-stop-sent", execution.Token);
                            values["nodeStopSent"] = sent;
                            if (heldStop)
                            {
                                var softHeld = await stopAckBarrier!.ReachedAsync(execution.Token);
                                var forceHeld = await faultBarrier!.ReachedAsync(execution.Token);
                                var softBinding = softHeld.GetProperty("observation").GetProperty("business");
                                var heldRequest = softBinding.GetProperty("request");
                                Program.Exact(heldRequest, "requestId", "mode", "stopRequestedAt", "terminateAfterAt");
                                var originalSoft = sent.GetProperty("facts").GetProperty("input").EnumerateArray()
                                    .Select(frame => Program.Parse(Program.Utf8.GetString(Convert.FromBase64String(frame.GetString()!))))
                                    .Single(frame => Program.Text(frame, "kind") == "command" && Program.Text(frame, "op") == "request-stop");
                                Program.Require(Program.Text(heldRequest, "requestId") == Program.Text(originalSoft, "requestId") && Program.Text(heldRequest, "mode") == "soft" &&
                                    heldRequest.GetProperty("stopRequestedAt").GetInt64() == sent.GetProperty("pair").GetProperty("stopRequestedAt").GetInt64() &&
                                    heldRequest.GetProperty("terminateAfterAt").GetInt64() == sent.GetProperty("pair").GetProperty("terminateAfterAt").GetInt64() &&
                                    !forceHeld.GetProperty("observation").GetProperty("business").GetProperty("forceAttempted").GetBoolean(), "execution_stop_original_ack_gate_binding");
                                long terminateAfterAt = sent.GetProperty("pair").GetProperty("terminateAfterAt").GetInt64();
                                if (Program.Now <= terminateAfterAt) await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(0, terminateAfterAt - Program.Now + 1)), execution.Token);
                                Program.Require(Program.Now > terminateAfterAt && engine.Alive && helper.Alive && bridgeQuery!.Alive, "execution_stop_original_force_window");
                                values["stopHeldBeforeForce"] = new { softHeld, forceHeld, observedAt = Program.Now, terminateAfterAt, originalEngineLive = engine.Alive,
                                    originalHelperLive = helper.Alive, originalBridgeLive = bridgeQuery!.Alive, extraEngineJobHandlesClosed = true };
                                await child.SendRawAsync(new { command = "request-force" }, execution.Token);
                                var forceAck = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-force-result", execution.Token);
                                Program.Require(Program.Text(forceAck.GetProperty("result"), "kind") == "stop-requested" && forceAck.GetProperty("softPending").GetBoolean(), "execution_stop_force_ack_while_soft_pending");
                                values["forceAckWithSoftHeld"] = forceAck;
                                if (scenario == "execution-node-stop-missing-ack") await faultBarrier.ReleaseAsync(execution.Token);
                                else await stopAckBarrier.ReleaseAsync(execution.Token);
                                var softAck = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-soft-result", execution.Token);
                                Program.Require(Program.Text(softAck.GetProperty("result"), "kind") == (scenario == "execution-node-stop-missing-ack" ? "unknown" : "stop-requested"), "execution_stop_soft_ack_original_result");
                                values["softResultBeforeFinalGateRelease"] = softAck;
                                if (scenario == "execution-node-stop-missing-ack") await stopAckBarrier.ReleaseAsync(execution.Token);
                                else
                                {
                                    Program.Require(engine.Alive, "execution_stop_soft_ack_before_unique_force");
                                    await faultBarrier.ReleaseAsync(execution.Token);
                                }
                            }
                        }
                        else if (scenario == "execution-node-deny-auth")
                        {
                            var denied = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-authorize-result", execution.Token);
                            Program.Require(Program.Text(denied.GetProperty("result"), "kind") == "unknown", "execution_node_denied_auth_unknown");
                            values["authDenied"] = denied;
                        }
                        else
                        {
                            JsonElement? held = faultBarrier is null ? null : await faultBarrier.ReachedAsync(execution.Token);
                            if (held.HasValue) values["faultStage"] = held.Value;
                            var peer = await run.PeerAsync("engine", descriptor, execution.Token);
                            if (scenario is not ("execution-node-missing-ack" or "execution-node-fast"))
                            {
                                var authorized = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-authorize-result", execution.Token);
                                Program.Require(Program.Text(authorized.GetProperty("result"), "kind") == "authorized", "execution_node_owner_auth_ack_required");
                                values["authAckBeforeFinish"] = authorized;
                            }
                            await peer.ReleaseAsync(scenario == "execution-node-nonzero" ? "finish-nonzero" : "finish", execution.Token);
                            values["finishSentBeforeAuthAckWait"] = scenario is "execution-node-fast" or "execution-node-missing-ack";
                            await engine.WaitAsync(execution.Token);
                            if (scenario == "execution-node-missing-ack")
                            {
                                await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-engine-exit-state", execution.Token);
                                var lost = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-authorize-result", execution.Token);
                                Program.Require(Program.Text(lost.GetProperty("result"), "kind") == "unknown", "execution_node_lost_auth_ack_stays_unknown");
                                values["lostAuthAck"] = lost;
                            }
                            if (faultBarrier is not null)
                            {
                                await child.SendRawAsync(new { command = "snapshot" }, execution.Token);
                                var snapshot = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-snapshot", execution.Token);
                                bool terminalAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId));
                                Program.Require(helper.Alive && bridgeQuery!.Alive && engine.Joined && terminalAbsent &&
                                    snapshot.GetProperty("originalBridgeAlive").GetBoolean() &&
                                    !snapshot.GetProperty("facts").GetProperty("stdoutEof").GetBoolean() &&
                                    !snapshot.GetProperty("facts").GetProperty("stderrEof").GetBoolean(), "execution_node_original_join_must_remain_incomplete");
                                if (snapshot.GetProperty("closeSettled").GetBoolean())
                                    Program.Require(Program.Text(snapshot.GetProperty("closeResult"), "kind") == "unknown" &&
                                        Program.Text(snapshot.GetProperty("closeResult"), "cleanup") == "unknown", "execution_node_bounded_close_keeps_unknown");
                                values["beforeBarrierRelease"] = new { snapshot, helperLive = helper.Alive, bridgeLive = bridgeQuery!.Alive,
                                    originalEngineJoined = engine.Joined, terminalAbsent, faultStage = held };
                                await faultBarrier.ReleaseAsync(execution.Token);
                                values["barrierReleasedAfterIncompleteObservation"] = true;
                            }
                        }
                        if (readerPinEnabled)
                        {
                            var held = await frames.MatchAsync(frame => Program.Text(frame, "kind") is "node-reader-input-held" or "node-result", execution.Token);
                            Program.Require(Program.Text(held, "kind") == "node-reader-input-held", "reader_original_input_gate_required");
                            Program.Exact(held, "kind", "candidatePid", "executionId", "requestFingerprint");
                            var candidatePid = held.GetProperty("candidatePid").GetUInt32();
                            Program.Require(candidatePid > 0 && Program.Text(held, "executionId") == executionId &&
                                Program.Text(held, "requestFingerprint") == parsed.RequestFingerprint, "reader_original_input_gate_binding");
                            readerStages.Add(new { sequence = readerStages.Count, stage = "held-observed", observedTick = Environment.TickCount64 });
                            reader = await run.RegisterObservedReaderAsync(candidatePid, execution.Token);
                            readerStages.Add(new { sequence = readerStages.Count, stage = "original-handle-adopted", identity = reader.Identity, observedTick = Environment.TickCount64 });
                            if (readerLossStage is not null)
                            {
                                await helper.WaitAsync(execution.Token);
                                await bridgeQuery!.WaitAsync(execution.Token);
                                await run.JoinEnginesAsync(execution.Token);
                                readerLossEngineJoins = run.EnginePins.Count == 1 && run.EnginePins.All(pin => pin.Joined && !pin.Alive);
                                Program.Require(helper.Joined && helper.ExitCode == 0 && bridgeQuery.Joined && bridgeQuery.ExitCode == 0 &&
                                    readerLossEngineJoins && engine.Joined && engine.ExitCode == 0, "reader_loss_original_predecessors_joined");
                                run.CloseJobHandles();
                                bool nodeReady = child.Pin!.Alive, readerReady = reader.Alive;
                                values["readerLossInjection"] = new { stage = readerLossStage, injectionPerformed = false,
                                    originalNode = child.Pin.Identity, originalReader = reader.Identity, nodeAliveAtCheck = nodeReady, readerAliveAtCheck = readerReady,
                                    unexercisedReason = !readerReady ? "reader-exited-before-injection" : !nodeReady ? "node-exited-before-injection" : null };
                                Program.Require(nodeReady && readerReady, "reader_loss_originals_live_before_input");
                                readerStages.Add(new { sequence = readerStages.Count, stage = "originals-joined-before-injection", identity = reader.Identity, observedTick = Environment.TickCount64 });
                            }
                            if (readerLossStage != "before-input")
                            {
                                readerStages.Add(new { sequence = readerStages.Count, stage = "release-send-started", identity = reader.Identity, observedTick = Environment.TickCount64 });
                                await child.SendRawAsync(new { command = "release-reader-input", identity = reader.Identity, executionId,
                                    requestFingerprint = parsed.RequestFingerprint }, execution.Token);
                                readerStages.Add(new { sequence = readerStages.Count, stage = "release-send-completed", identity = reader.Identity, observedTick = Environment.TickCount64 });
                            }
                            if (readerLossStage is not null)
                            {
                                if (readerLossStage == "after-input")
                                {
                                    var delivered = await frames.MatchAsync(frame => Program.Text(frame, "kind") is "node-reader-input-delivered" or "node-result", execution.Token);
                                    if (Program.Text(delivered, "kind") != "node-reader-input-delivered")
                                    {
                                        bool readerLive = reader.Alive;
                                        values["readerLossInjection"] = new { stage = readerLossStage, injectionPerformed = false,
                                            originalNode = child.Pin!.Identity, originalReader = reader.Identity,
                                            readerAliveAtCheck = readerLive,
                                            unexercisedReason = !readerLive ? "reader-exited-before-injection" : "result-before-input-delivery" };
                                    }
                                    Program.Require(Program.Text(delivered, "kind") == "node-reader-input-delivered", "reader_loss_result_preceded_injection");
                                    Program.Exact(delivered, "kind", "candidatePid", "executionId", "requestFingerprint", "endCalls", "endCallbacks", "stdinFinish", "endCallbackSucceeded");
                                    Program.Require(delivered.GetProperty("candidatePid").GetUInt32() == reader.Identity.Pid &&
                                        Program.Text(delivered, "executionId") == executionId && Program.Text(delivered, "requestFingerprint") == parsed.RequestFingerprint &&
                                        delivered.GetProperty("endCalls").GetInt32() == 1 && delivered.GetProperty("endCallbacks").GetInt32() == 1 &&
                                        delivered.GetProperty("stdinFinish").GetBoolean() && delivered.GetProperty("endCallbackSucceeded").GetBoolean(), "reader_loss_original_input_delivery_binding");
                                    readerStages.Add(new { sequence = readerStages.Count, stage = "input-delivered-observed", identity = reader.Identity, observedTick = Environment.TickCount64 });
                                }
                                bool resultFilePresent = File.Exists(Path.Combine(directory, "node-adapter-return.json"));
                                bool resultFramePresent = frames.Snapshot.Any(frame => Program.Text(frame, "kind") == "node-result");
                                bool nodeAlive = child.Pin!.Alive, readerAlive = reader.Alive;
                                values["readerLossInjection"] = new { stage = readerLossStage, injectionPerformed = false,
                                    originalNode = child.Pin.Identity, originalReader = reader.Identity, nodeAliveAtCheck = nodeAlive, readerAliveAtCheck = readerAlive,
                                    unexercisedReason = !readerAlive ? "reader-exited-before-injection" : !nodeAlive ? "node-exited-before-injection" :
                                        resultFilePresent || resultFramePresent ? "result-before-injection" : null };
                                Program.Require(!resultFilePresent && !resultFramePresent, "reader_loss_result_already_formed");
                                Program.Require(nodeAlive && readerAlive, "reader_loss_originals_live_at_injection");
                                values["readerLossBefore"] = new { stage = readerLossStage, originalNode = child.Pin.Identity, originalReader = reader.Identity,
                                    originalBridge = bridgeQuery!.Identity, originalHelper = helper.Identity, originalEngine = engine.Identity,
                                    nodeAliveAtCheck = nodeAlive, readerAliveAtCheck = readerAlive, readerAdopted = true,
                                    originalNodeRegistrationAcknowledged = true, originalReaderRegistrationAcknowledged = true,
                                    originalHelperJoined = helper.Joined, helperExitCode = helper.ExitCode, originalBridgeJoined = bridgeQuery.Joined,
                                    bridgeExitCode = bridgeQuery.ExitCode, originalEngineJoined = engine.Joined, engineExitCode = engine.ExitCode,
                                    extraEngineJobHandlesClosed = true, executionId, requestFingerprint = parsed.RequestFingerprint };
                                readerStages.Add(new { sequence = readerStages.Count, stage = "injection-live-check", identity = reader.Identity, observedTick = Environment.TickCount64 });
                                child.Terminate();
                                values["readerLossInjection"] = new { stage = readerLossStage, injectionPerformed = true,
                                    originalNode = child.Pin.Identity, originalReader = reader.Identity, nodeAliveAtCheck = nodeAlive, readerAliveAtCheck = readerAlive,
                                    intentionalOriginalNodeTermination = true, otherOriginalProcessTerminatedByFixture = false };
                                await child.Pin.WaitAsync(execution.Token);
                                Program.Require(child.Forced && child.Pin.ExitCode == 1, "reader_loss_original_node_exit1");
                                values["readerLossInjection"] = new { stage = readerLossStage, injectionPerformed = true,
                                    originalNode = child.Pin.Identity, originalReader = reader.Identity, nodeAliveAtCheck = nodeAlive, readerAliveAtCheck = readerAlive,
                                    intentionalOriginalNodeTermination = true, originalNodeJoined = child.Pin.Joined, exitCode = child.Pin.ExitCode,
                                    otherOriginalProcessTerminatedByFixture = false };
                                await reader.WaitAsync(execution.Token);
                                Program.Require(reader.Joined && !reader.Alive && (readerLossStage == "before-input" ? reader.ExitCode == 2 : reader.ExitCode is 0 or 2), "reader_loss_original_reader_natural_exit");
                            }
                        }
                        if (readerLossStage is null)
                        {
                            var result = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "node-result", execution.Token);
                            values["nodeResult"] = result;
                            Program.Require(!result.TryGetProperty("failure", out _), "execution_node_runner_failed");
                            Program.Require(!result.TryGetProperty("adapter", out var adapter) || !adapter.GetBoolean() || readerPinEnabled, "reader_adapter_mode_required");
                            if (readerPinEnabled)
                            {
                                Program.Require(result.GetProperty("adapter").GetBoolean() && reader is not null &&
                                    frames.Snapshot.Count(frame => Program.Text(frame, "kind") == "node-reader-input-held") == 1, "reader_exactly_one_original_gate");
                                await reader!.WaitAsync(execution.Token);
                                Program.Require(reader.ExitCode == 0, "reader_original_natural_exit0");
                            }
                            values["bridgeLaunches"] = result.GetProperty("factsAtReturn").GetProperty("spawnCount").GetInt32();
                        }
                    }
                    }
                }
            }
            else
            {
                await child.SendRawAsync(new
                {
                    v = 1, kind = "command", requestId = prepareId, op = "prepare", executionId,
                    requestUtf8Base64 = Program.Text(run.Carrier, "requestUtf8Base64"),
                    requestFingerprint = Program.Text(run.Carrier, "requestFingerprint"),
                }, execution.Token);
                var result = await frames.MatchAsync(frame => Program.Text(frame, "kind") is "permit-request" or "unknown" or "closed", execution.Token);
                values["firstPrepareResponse"] = result;
                if (rawInterleaving) Program.Require(Program.Text(result, "kind") == "permit-request", "execution_raw_prepare_permit_required");
                if (Program.Text(result, "kind") == "permit-request")
                {
                    Program.Exact(result, "v", "kind", "requestId", "op", "executionId", "requestFingerprint");
                    Program.Require(Program.Text(result, "requestId") == prepareId && Program.Text(result, "op") == "prepare" &&
                        Program.Text(result, "executionId") == executionId && Program.Text(result, "requestFingerprint") == Program.Text(run.Carrier, "requestFingerprint"), "execution_bridge_exact_original_permit");
                    var preparePermit = Program.Utf8.GetBytes(JsonSerializer.Serialize(new
                    {
                        v = 1, kind = "permit", requestId = prepareId, op = "prepare", executionId,
                        requestFingerprint = Program.Text(run.Carrier, "requestFingerprint"), allow = true,
                    }, Program.Json) + "\n");
                    await child.SendRawBytesAsync(preparePermit, execution.Token);
                    var prepared = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" &&
                        frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == prepareId ||
                        Program.Text(frame, "kind") is "unknown" or "closed", execution.Token);
                    values["prepareResponse"] = prepared;
                    if (rawInterleaving) Program.Require(Program.Text(prepared, "kind") == "state", "execution_raw_prepared_ack_required");
                    if (Program.Text(prepared, "kind") == "state")
                    {
                        Program.Require(Program.Text(prepared.GetProperty("state"), "phase") == "prepared", "execution_bridge_prepared_state_required");
                        var descriptor = prepared.GetProperty("state").GetProperty("descriptor").Clone();
                        values["descriptor"] = descriptor;
                        run.PinDescriptor(descriptor);
                        var engine = run.PinFact(descriptor.GetProperty("details").GetProperty("engine"));
                        await run.RegisterAsync(engine, execution.Token);
                        values["rawPreparedEngine"] = engine.Identity;
                        if (!rawInterleaving)
                            await child.SendRawAsync(new { v = 1, kind = "command", requestId = closeId, op = "close", executionId }, execution.Token);
                        else
                        {
                            var details = descriptor.GetProperty("details");
                            Program.Require(!prepared.GetProperty("state").GetProperty("authorizationVerified").GetBoolean() &&
                                Program.Text(prepared.GetProperty("state"), "resumeState") == "not-attempted" &&
                                Program.Text(descriptor, "executionId") == executionId &&
                                Program.Text(details, "requestFingerprint") == parsed.RequestFingerprint &&
                                Program.Text(details, "installationManifestSha256") == run.Bundle.ManifestSha256 &&
                                Program.Equal(details.GetProperty("target"), run.Scope.Target) &&
                                Program.Equal(details.GetProperty("supervisor"), helperFact), "execution_raw_original_descriptor_binding");
                            var preparedProbe = run.PreparedProbe(descriptor);
                            run.CloseJobHandles();
                            bool authAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId));
                            Program.Require(authAbsent && !child.RawInputClosed, "execution_raw_unresumed_boundary");
                            values["rawBeforeInterleaving"] = new { preparedProbe, originalBridge = child.Pin!.Identity,
                                originalHelper = helper.Identity, originalEngine = engine.Identity, authorizationRecordAbsent = authAbsent,
                                registrationAcknowledgements = new[] { child.Pin.Identity, helper.Identity, engine.Identity },
                                membershipEvidenceSource = "original-external-job-registration-ack-after-identity-and-injob", extraEngineJobHandlesClosed = true };
                            if (scenario == "execution-permit-replay")
                                await child.SendRawBytesAsync(preparePermit, execution.Token);
                            else
                            {
                                await child.SendRawAsync(new { v = 1, kind = "command", requestId = authorizeId, op = "authorize", executionId,
                                    target = details.GetProperty("target"), descriptor, requestFingerprint = parsed.RequestFingerprint }, execution.Token);
                                var authPermit = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "permit-request" &&
                                    Program.Text(frame, "requestId") == authorizeId && Program.Text(frame, "op") == "authorize" ||
                                    Program.Text(frame, "kind") is "unknown" or "closed", execution.Token);
                                Program.Exact(authPermit, "v", "kind", "requestId", "op", "executionId", "requestFingerprint");
                                Program.Require(Program.Text(authPermit, "kind") == "permit-request" &&
                                    Program.Text(authPermit, "requestId") == authorizeId && Program.Text(authPermit, "op") == "authorize" &&
                                    Program.Text(authPermit, "executionId") == executionId && Program.Text(authPermit, "requestFingerprint") == parsed.RequestFingerprint,
                                    "execution_raw_exact_auth_permit_barrier");
                                values["rawAuthPermitRequest"] = authPermit;
                                if (scenario == "execution-permit-close")
                                    await child.SendRawAsync(new { v = 1, kind = "command", requestId = closeId, op = "close", executionId }, execution.Token);
                                else if (scenario is "execution-natural-close-id" or "execution-stop-wire")
                                {
                                    await child.SendRawAsync(new { v = 1, kind = "permit", requestId = authorizeId, op = "authorize", executionId,
                                        requestFingerprint = parsed.RequestFingerprint, allow = true }, execution.Token);
                                    if (scenario == "execution-stop-wire")
                                    {
                                        var authorized = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" &&
                                            frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == authorizeId ||
                                            Program.Text(frame, "kind") is "unknown" or "closed", execution.Token);
                                        values["rawAuthResponse"] = authorized;
                                        Program.Require(Program.Text(authorized, "kind") == "state" &&
                                            authorized.GetProperty("state").GetProperty("authorizationVerified").GetBoolean() &&
                                            Program.Text(authorized.GetProperty("state"), "resumeState") == "succeeded", "execution_raw_original_auth_ack_required");
                                    }
                                    var peer = await run.PeerAsync("engine", descriptor, execution.Token);
                                    Program.Require(peer.Pin.Identity == engine.Identity && engine.Alive, "execution_raw_original_engine_peer");
                                    run.CloseJobHandles();
                                    if (scenario == "execution-stop-wire")
                                    {
                                        var markerIdentity = Program.Parse(Program.Utf8.GetString(File.ReadAllBytes(run.Marker))).Deserialize<ProcessFact>(Program.Json);
                                        bool authPresent = File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId));
                                        Program.Require(markerIdentity == engine.Identity && authPresent && !child.RawInputClosed,
                                            "execution_raw_stop_original_running_boundary");
                                        long stopRequestedAt = checked(Program.Now - parsed.Limits.CancelGraceMs / 2), terminateAfterAt = checked(stopRequestedAt + parsed.Limits.CancelGraceMs);
                                        var command = new { v = 1, kind = "command", requestId = stopId, op = "request-stop", executionId,
                                            target = details.GetProperty("target"), descriptor, requestFingerprint = parsed.RequestFingerprint,
                                            mode = "soft", stopRequestedAt, terminateAfterAt };
                                        values["rawStopBeforeRequest"] = new { originalBridge = child.Pin!.Identity, originalHelper = helper.Identity,
                                            originalEngine = engine.Identity, peer = peer.Pin.Identity, markerIdentity, originalEngineLive = engine.Alive,
                                            authorizationRecordPresent = authPresent, callerInputOpen = !child.RawInputClosed,
                                            completedInputFrames = child.RawSendCount, extraEngineJobHandlesClosed = true };
                                        values["rawStopCommand"] = command;
                                        await child.SendRawAsync(command, execution.Token);
                                        var stopResponse = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "permit-request" &&
                                            Program.Text(frame, "requestId") == stopId && Program.Text(frame, "op") == "request-stop" ||
                                            Program.Text(frame, "kind") is "unknown" or "closed", execution.Token);
                                        values["firstStopResponse"] = stopResponse;
                                        if (Program.Text(stopResponse, "kind") == "permit-request")
                                        {
                                            Program.Exact(stopResponse, "v", "kind", "requestId", "op", "executionId", "requestFingerprint");
                                            Program.Require(Program.Text(stopResponse, "requestId") == stopId && Program.Text(stopResponse, "op") == "request-stop" &&
                                                Program.Text(stopResponse, "executionId") == executionId && Program.Text(stopResponse, "requestFingerprint") == parsed.RequestFingerprint,
                                                "execution_raw_exact_stop_permit");
                                            await child.SendRawAsync(new { v = 1, kind = "permit", requestId = stopId, op = "request-stop", executionId,
                                                requestFingerprint = parsed.RequestFingerprint, allow = true }, execution.Token);
                                            stopResponse = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" &&
                                                frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == stopId ||
                                                Program.Text(frame, "kind") is "unknown" or "closed", execution.Token);
                                        }
                                        values["rawStopResponse"] = stopResponse;
                                        values["rawStopAfterResponse"] = new { callerInputOpen = !child.RawInputClosed, completedInputFrames = child.RawSendCount };
                                        if (Program.Text(stopResponse, "kind") == "state")
                                            await child.SendRawAsync(new { v = 1, kind = "command", requestId = closeId, op = "close", executionId }, execution.Token);
                                    }
                                    else
                                    {
                                        await peer.ReleaseAsync("finish", execution.Token);
                                        var ending = await frames.MatchAsync(frame => Program.Text(frame, "kind") is "ending" or "unknown" or "closed", execution.Token);
                                        Program.Require(Program.Text(ending, "kind") == "ending" && Program.Text(ending, "executionId") == executionId &&
                                            !child.RawInputClosed, "execution_raw_natural_ending_before_caller_close");
                                        values["rawNaturalBeforeClose"] = new { finishReleaseCompleted = true, ending, callerInputOpen = !child.RawInputClosed,
                                            completedInputFrames = child.RawSendCount, originalEngine = peer.Pin.Identity, extraEngineJobHandlesClosed = true };
                                        await child.SendRawAsync(new { v = 1, kind = "command", requestId = closeId, op = "close", executionId }, execution.Token);
                                    }
                                }
                            }
                            values["rawBeforeInputEof"] = new { callerInputOpen = !child.RawInputClosed, completedInputFrames = child.RawSendCount };
                        }
                    }
                }
            }
            // A legal baseline Unknown is recorded as protocol data, not a fixture failure.
            child.CloseRawInput();
            await child.JoinAsync(execution.Token);
            if (readerPinEnabled)
                Program.Require(reader is not null && reader.Joined && !reader.Alive &&
                    frames.Snapshot.Count(frame => Program.Text(frame, "kind") == "node-reader-input-held") == 1, "reader_final_original_gate_join");
            await helper.WaitAsync(execution.Token);
            if (bridgeQuery is not null)
                await bridgeQuery.WaitAsync(execution.Token);
            if (readerLossStage is not null)
            {
                Program.Require(!File.Exists(Path.Combine(directory, "node-adapter-return.json")) &&
                    frames.Snapshot.All(frame => Program.Text(frame, "kind") != "node-result") &&
                    frames.Snapshot.Count(frame => Program.Text(frame, "kind") == "node-reader-input-delivered") == (readerLossStage == "after-input" ? 1 : 0), "reader_loss_exact_events_without_final_result");
                values["readerLossAfter"] = new { node = new { identity = child.Pin!.Identity, originalJoined = child.OriginalJoined, exitCode = child.Pin.ExitCode,
                    forced = child.Forced, stdoutEof = child.RawOutput!.Eof, stderrEof = child.RawError!.Eof },
                    reader = reader!.Evidence(), helper = helper.Evidence(), bridge = bridgeQuery!.Evidence(),
                    engines = run.EnginePins.Select(pin => pin.Evidence()).ToArray(), originalAdapterResultObserved = false };
            }
            if (callerDeathStage is not null)
            {
                await run.JoinEnginesAsync(execution.Token);
                callerDeathEngineJoins = run.EnginePins.All(pin => pin.Joined && !pin.Alive);
                Program.Require(bridgeQuery!.ExitCode == 2, "caller_death_bridge_eof_fault_exit2");
                values["callerDeathAfter"] = new { node = child.RawEvidence(), bridge = bridgeQuery.Evidence(), helper = helper.Evidence(),
                    engines = run.EnginePins.Select(pin => pin.Evidence()).ToArray(),
                    requestRecordAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.RequestId)),
                    preparedRecordAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.PreparedId)),
                    authorizationRecordAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId)) };
            }
            if (rawInterleaving || nodeStop)
            {
                await run.JoinEnginesAsync(execution.Token);
                rawEngineJoins = run.EnginePins.Count == 1 && run.EnginePins.All(pin => pin.Joined && !pin.Alive);
                Program.Require(rawEngineJoins, "execution_raw_original_engine_join_required");
                values["rawAfter"] = new { engines = run.EnginePins.Select(pin => pin.Evidence()).ToArray(),
                    authorizationRecordAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId)) };
            }
            if ((nodeScenario || rawInterleaving) && !prepareDenied)
            {
                Program.Require(helper.ExitCode == 0, "execution_node_trusted_helper_natural_exit0");
                var before = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
                object Read(JournalResult result) => new { status = result.Status == JournalStatus.Existing ? "existing" : "unknown",
                    snapshot = result.Status == JournalStatus.Existing ? result.Snapshot : null };
                var reservation = Read(ProtectedJournal.InspectReservation(run.RecordsRoot, run.Scope));
                var request = Read(ProtectedJournal.Read(run.RecordsRoot, run.Scope, executionId, Readback.RequestId));
                var prepared = Read(ProtectedJournal.Read(run.RecordsRoot, run.Scope, executionId, Readback.PreparedId));
                var authorization = Read(ProtectedJournal.Read(run.RecordsRoot, run.Scope, executionId, Readback.AuthId));
                var controllerLoss = Read(ProtectedJournal.Read(run.RecordsRoot, run.Scope, executionId, Readback.LossId));
                var terminal = Read(ProtectedJournal.Read(run.RecordsRoot, run.Scope, executionId, Readback.TerminalId));
                values["strictSnapshot"] = new { v = 1, kind = "windows-journal-snapshot",
                    reservation, records = new { request, prepared, authorization, controllerLoss, terminal } };
                var after = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
                Program.Require(Program.Equal(before, after), "execution_node_strict_reader_did_not_mutate");
                values["readerOrdinaryAssemblySha256"] = Program.Hash(File.ReadAllBytes(typeof(ProtectedJournal).Assembly.Location));
            }
        }
        catch (Exception error)
        {
            if (run is null) setupFailure = Program.Error(error);
            else failure = Program.Error(error);
        }
        var cleanupAt = Math.Min(Environment.TickCount64 + cleanupMs, deadlineTick + cleanupMs);
        Program.Write(new { kind = "host-cleanup-start", deadlineTick = cleanupAt });
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupAt - Environment.TickCount64)));
        if (prepareFault is not null)
            try { prepareFault.Restore(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        if (faultBarrier is not null)
            try { await faultBarrier.DisposeAsync(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        if (stopAckBarrier is not null)
            try { await stopAckBarrier.DisposeAsync(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        if (child?.Started is true)
        {
            try { child.CloseRawInput(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            if (failure is not null && !child.OriginalJoined)
                try { child.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            try { await child.JoinAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        }
        if (helper is not null)
            try { await helper.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        if (bridgeQuery is not null)
            try { await bridgeQuery.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        if (reader is not null)
        {
            if (readerLossStage is null && failure is not null && !reader.Joined && reader.Alive)
                try { reader.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            try { await reader.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        }
        if (readerLossStage is not null && run is not null)
        {
            try
            {
                await run.JoinEnginesAsync(cleanup.Token);
                readerLossEngineJoins = run.EnginePins.Count == 1 && run.EnginePins.All(pin => pin.Joined && !pin.Alive);
            }
            catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            values["readerLossResultFilePresent"] = File.Exists(Path.Combine(directory, "node-adapter-return.json"));
        }
        try { await inputTask.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        values["child"] = child?.RawEvidence();
        values["frames"] = frames.Snapshot;
        values["helper"] = helper is null ? null : new { identity = helper.Identity, originalJoined = helper.Joined, exitCode = helper.ExitCode, evidenceSource = "trusted-product-bridge-statement-plus-exact-identity-query" };
        values["bridge"] = bridgeQuery is null ? null : new { identity = bridgeQuery.Identity, originalJoined = bridgeQuery.Joined, exitCode = bridgeQuery.ExitCode,
            evidenceSource = "original-node-spawn-observation-plus-exact-identity-query" };
        if (readerPinEnabled)
        {
            values["reader"] = reader is null ? null : new { role = "journal-reader", identity = reader.Identity, originalJoined = reader.Joined,
                alive = reader.Alive, exitCode = reader.ExitCode, nonInherited = reader.NonInherited, sameSid = reader.SameSid, adopted = true,
                registrationSource = "original-reader-job-notification", originalNotificationRetained = true, independentCreationPin = false };
            values["readerStages"] = readerStages;
        }
        values["markerPresent"] = run is not null && File.Exists(run.Marker);
        try { values["readerFiles"] = run?.ReaderFiles(); }
        catch (Exception error) { cleanupFailures.Add(new { stage = "reader-files", error = Program.Error(error) }); }
        if (!values.ContainsKey("bridgeLaunches")) values["bridgeLaunches"] = child?.Started is true ? 1 : 0;
        values["fixtureHelperLaunches"] = 0;
        if (run is not null)
            try { await run.DisposeAsync(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        var joined = child?.OriginalJoined is true && child.RawOutput?.Eof is true && child.RawError?.Eof is true && helper?.Joined is true &&
            (bridgeQuery is null || bridgeQuery.Joined) && (!readerPinEnabled || reader is not null && reader.Joined && !reader.Alive) &&
            (readerLossStage is null || readerLossEngineJoins) &&
            (callerDeathStage is null || callerDeathEngineJoins) && (!(rawInterleaving || nodeStop) || rawEngineJoins);
        Program.Write(new { kind = "receipt", value = new { scenario, setupFailure, failure, values,
            cleanup = new { failures = cleanupFailures, originalRegistry = true, allObservedJoined = joined } } });
        reader?.Dispose(); bridgeQuery?.Dispose(); helper?.Dispose(); child?.Dispose();
        return cleanupFailures.Count == 0 ? 0 : 1;
    }

    private static async Task InjectCallerDeathAsync(string stage, Frames frames, RunContext run, Child child,
        ProcessPin bridge, ProcessPin helper, JsonElement bound, JsonElement? descriptor, ProcessPin? engine,
        Dictionary<string, object?> values, CancellationToken token)
    {
        var ready = await frames.MatchAsync(frame => Program.Text(frame, "kind") is "node-death-ready" or "node-result", token);
        Program.Require(Program.Text(ready, "kind") == "node-death-ready", "caller_death_original_marker_missing");
        Program.Exact(ready, "kind", "stage", "binding", "descriptor", "preparePermits", "authPermits", "markerPresent", "facts");
        var facts = ready.GetProperty("facts");
        Program.Require(Program.Text(ready, "stage") == stage && JsonElement.DeepEquals(ready.GetProperty("binding"), bound) &&
            ready.GetProperty("preparePermits").GetInt32() == (stage == "never-prepare" ? 0 : 1) &&
            ready.GetProperty("authPermits").GetInt32() == (stage == "running" ? 1 : 0) &&
            facts.GetProperty("spawnCount").GetInt32() == 1 && facts.GetProperty("detachedRequested").GetBoolean() &&
            facts.GetProperty("originalPid").GetUInt32() == bridge.Identity.Pid &&
            (descriptor.HasValue ? JsonElement.DeepEquals(ready.GetProperty("descriptor"), descriptor.Value) : ready.GetProperty("descriptor").ValueKind == JsonValueKind.Null),
            "caller_death_exact_stage_binding");
        var requestAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.RequestId));
        var preparedAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.PreparedId));
        var authAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId));
        Program.Require(child.Pin!.Alive && bridge.Alive && helper.Alive && (engine is null || engine.Alive), "caller_death_originals_must_be_live");
        Program.Require(stage == "running" ? !authAbsent : authAbsent && !File.Exists(run.Marker) && !ready.GetProperty("markerPresent").GetBoolean(), "caller_death_authorization_boundary");
        if (stage == "never-prepare") Program.Require(requestAbsent && preparedAbsent && run.EnginePins.Count == 0, "caller_death_never_prepared");
        run.CloseJobHandles();
        values["callerDeathBefore"] = new { stage, ready, originalNode = child.Pin.Identity, originalBridge = bridge.Identity, originalHelper = helper.Identity,
            originalEngine = engine?.Identity, requestRecordAbsent = requestAbsent, preparedRecordAbsent = preparedAbsent, authorizationRecordAbsent = authAbsent,
            registrationAcknowledgements = new[] { child.Pin.Identity, bridge.Identity, helper.Identity }.Concat(engine is null ? [] : new[] { engine.Identity }).ToArray(),
            membershipEvidenceSource = "original-external-job-registration-ack-after-identity-and-injob", extraEngineJobHandlesClosed = true };
        child.Terminate();
        await child.Pin.WaitAsync(token);
        Program.Require(child.Forced && child.Pin.ExitCode == 1, "caller_death_original_node_exit1");
        values["callerDeathInjection"] = new { originalNode = child.Pin.Identity, intentionalOriginalNodeTermination = true, originalNodeJoined = child.Pin.Joined,
            exitCode = child.Pin.ExitCode, helperOrEngineTerminatedByFixture = false };
        values["bridgeLaunches"] = facts.GetProperty("spawnCount").GetInt32();
    }
}
