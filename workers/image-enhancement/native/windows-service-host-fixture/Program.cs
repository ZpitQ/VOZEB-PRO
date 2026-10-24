using System.ComponentModel;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsServiceHost;
using Zeb.WindowsSupervisor;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsServiceHostFixture;

internal static partial class Program
{
    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static string Executable => Environment.ProcessPath ?? throw new InvalidOperationException("Fixture apphost is unavailable.");

    private static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = Utf8;
        Console.OutputEncoding = Utf8;
        try
        {
            Require(OperatingSystem.IsWindows(), "windows_required");
            return args.FirstOrDefault() switch
            {
                "case" when args.Length == 7 => await RunCaseAsync(args),
                "host" when args.Length == 10 => await RunHostAsync(args),
                "hung" when args.Length == 5 => await RunHungAsync(args),
                "product-empty" when args.Length == 5 => await RunMissingPayloadAsync(args),
                "product-startup" when args.Length == 6 => await RunMissingPayloadAsync(args),
                "stop-before-start-child" when args.Length == 5 => await RunStopBeforeStartChildAsync(
                    args[1], args[2], args[3], long.Parse(args[4], CultureInfo.InvariantCulture)),
                "graceful-before-start-child" when args.Length == 5 => await RunStopBeforeStartChildAsync(
                    args[1], args[2], args[3], long.Parse(args[4], CultureInfo.InvariantCulture), graceful: true),
                "bridge-outer" when args.Length == 7 => await RunNestedAsync(args),
                "worker-stop" when args.Length == 7 => await RunWorkerStopAsync(args),
                "startup-observation-case" when args.Length == 7 => await RunStartupObservationCaseAsync(args),
                "startup-observation-host" when args.Length == 7 => await RunStartupObservationHostAsync(args),
                "startup-final-case" when args.Length == 7 => await RunStartupFinalCaseAsync(args),
                "startup-final-host" when args.Length == 8 => await RunStartupFinalHostAsync(args),
                "startup-phase-controls" when args.Length == 2 => RunStartupPhaseControls(args[1]),
                "startup-cleanup-controls" when args.Length == 2 => RunStartupCleanupControls(args[1]),
                "service-startup-case" when args.Length == 7 => await RunServiceStartupCaseAsync(args),
                "service-startup-host" when args.Length == 8 => await RunServiceStartupHostAsync(args),
                _ => throw new ArgumentException("Unknown fixture mode.")
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static async Task<int> RunCaseAsync(string[] args)
    {
        string scenario = args[1], directory = Path.GetFullPath(args[2]);
        int executionMs = int.Parse(args[3], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[4], CultureInfo.InvariantCulture);
        string node = Path.GetFullPath(args[5]), main = Path.GetFullPath(args[6]);
        bool graceful = scenario.StartsWith("graceful-", StringComparison.Ordinal);
        bool needsHung = scenario != "graceful-cooperate";
        Require(scenario is "root-exit" or "host-death" or "stop-race" or "sink-failure" or "stop-before-start" or
            "graceful-cooperate" or "graceful-ignore" or "graceful-root-hung" or "graceful-nonzero" or
            "graceful-hard-stop" or "graceful-sink-failure" or "graceful-before-start", "unknown_case");
        Require(executionMs > 0 && cleanupMs > 0 && Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any(), "empty_case_directory_required");
        if (scenario == "stop-before-start") return await RunStopBeforeStartAsync(directory, node, main, executionMs, cleanupMs);
        if (scenario == "graceful-before-start") return await RunStopBeforeStartAsync(directory, node, main, executionMs, cleanupMs, graceful: true);

        using var execution = new CancellationTokenSource(executionMs);
        long deadlineTick = checked(Environment.TickCount64 + executionMs);
        string prefix = "Zeb-service-host-" + Guid.NewGuid().ToString("N");
        using var control = new NamedPipeServerStream(prefix + "-control", PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var hungReady = new NamedPipeServerStream(prefix + "-hung", PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        string fixedNodeImage = Native.FileIdentity(node), fixedFixtureImage = Native.FileIdentity(Executable);
        string systemDirectory = Environment.SystemDirectory;
        Require(Path.IsPathFullyQualified(systemDirectory), "trusted_system_directory_unavailable");
        string systemConsolePath = Path.GetFullPath(Path.Combine(systemDirectory, "conhost.exe"));
        string systemConsoleImage = Native.FileIdentity(systemConsolePath);
        string expectedSid;
        using (var current = WindowsIdentity.GetCurrent()) expectedSid = current.User?.Value ?? throw new InvalidDataException("current_sid_unavailable");
        var facts = new Dictionary<string, object?> { ["scenario"] = scenario };
        var failures = new List<string>();
        var pins = new List<ProcessPin>();
        var systemConsoles = new List<ProcessPin>();
        int expectedPrincipalPins = 1;
        JobProcess? safety = null;
        Task<StreamEnd>? hostStdout = null, hostStderr = null;
        JobTreeExit? safetyExit = null;
        StreamEnd? output = null, errorOutput = null;
        object? finalSafetyAccounting = null;
        bool guardianUsed = false, injectionOccurred = false, allPinsJoined = false;
        JsonElement? completed = null;
        try
        {
            var observer = Native.Identity(new IntPtr(-1));
            safety = JobProcess.Prepare(Executable,
                ["host", scenario, directory, prefix, observer.Pid.ToString(CultureInfo.InvariantCulture), observer.CreationFileTime,
                    node, main, deadlineTick.ToString(CultureInfo.InvariantCulture), cleanupMs.ToString(CultureInfo.InvariantCulture)], directory);
            hostStdout = DrainAsync(safety.StandardOutput);
            hostStderr = DrainAsync(safety.StandardError);
            var host = ProcessPin.OpenQualified(ToFact(safety.EngineIdentity), Executable, fixedFixtureImage, safety.JobName);
            pins.Add(host);
            Require(safety.AuthorizeOnce(), "safety_host_authorize_once");
            await control.WaitForConnectionAsync(execution.Token);
            using var input = new StreamReader(control, Utf8, false, leaveOpen: true);
            await using var commands = new StreamWriter(control, Utf8, leaveOpen: true) { AutoFlush = true };
            var waiting = await ReadAsync(input, execution.Token);
            Require(waiting.GetProperty("kind").GetString() == "host-waiting" && host.Alive, "host_initial_gate");
            await commands.WriteLineAsync("start");
            var start = await ReadAsync(input, execution.Token);
            facts["start"] = start;
            Require(start.GetProperty("kind").GetString() == "host-start", "host_start_receipt_required");
            bool startSucceeded = start.GetProperty("startSucceeded").GetBoolean();
            expectedPrincipalPins = startSucceeded ? (needsHung ? 3 : 2) : 1;
            if (!startSucceeded)
            {
                // A loaded real core reporting NotImplementedException is the intentional StageT behavior RED.
                Require(start.GetProperty("workerStarts").GetInt32() == 0 && !start.GetProperty("completionCompleted").GetBoolean(), "throw_only_core_must_not_launch_or_complete");
                failures.Add("CoreStartFailed: " + start.GetProperty("startFailureType").GetString());
                await host.JoinAsync(execution.Token);
                safetyExit = await safety.WaitForTreeExitAsync(execution.Token);
            }
            else
            {
                string jobName = start.GetProperty("jobName").GetString() ?? throw new InvalidDataException("original_job_name_missing");
                var rootIdentity = start.GetProperty("root").Deserialize<ProcessFact>(Json) ?? throw new InvalidDataException("original_root_identity_missing");
                var root = ProcessPin.OpenQualified(rootIdentity, node, fixedNodeImage, jobName);
                pins.Add(root);
                ProcessPin? hung = null;
                if (needsHung)
                {
                    await hungReady.WaitForConnectionAsync(execution.Token);
                    using var hungInput = new StreamReader(hungReady, Utf8, false, leaveOpen: true);
                    var proof = (await ReadAsync(hungInput, execution.Token)).Deserialize<HandleProof>(Json) ?? throw new InvalidDataException("hung_original_handle_missing");
                    hung = ProcessPin.TakeTransferred(proof, Executable, fixedFixtureImage, jobName);
                    pins.Add(hung);
                }
                var principals = hung is null ? new[] { root } : new[] { root, hung! };
                if (graceful)
                {
                    // Both frozen writers must have crossed the actual flushing sink before it can be failed.
                    long expectedInitialStdoutBytes = Utf8.GetByteCount("original-node-ready\n") +
                        (needsHung ? Utf8.GetByteCount("hung-stdout" + Environment.NewLine) : 0);
                    while (true)
                    {
                        long observedInitialStdoutBytes = new FileInfo(Path.Combine(directory, "worker.stdout.bin")).Length;
                        Require(observedInitialStdoutBytes <= expectedInitialStdoutBytes, "graceful_initial_stdout_exact_budget");
                        if (observedInitialStdoutBytes == expectedInitialStdoutBytes && RootStarts(directory) == 1) break;
                        await Task.Delay(10, execution.Token);
                    }
                }
                var initialCensus = Native.ObserveAndCloseJob(jobName, principals);
                facts["initialCensus"] = initialCensus;
                Require(initialCensus.MemberIds.Distinct().Count() == initialCensus.MemberIds.Length, "original_census_must_not_duplicate_member_ids");
                int[] principalMemberIds = principals.Select(pin => pin.Identity.Pid).ToArray();
                foreach (int memberId in initialCensus.MemberIds.Where(memberId => !principalMemberIds.Contains(memberId)))
                    systemConsoles.Add(ProcessPin.OpenSystemConsole(memberId, systemConsolePath, systemConsoleImage, jobName));
                var innerPins = principals.Concat(systemConsoles).ToArray();
                var registeredInnerIdentities = innerPins.Select(pin => pin.Identity).ToArray();
                int[] expectedMemberIds = registeredInnerIdentities.Select(identity => identity.Pid).Order().ToArray();
                var census = Native.ObserveAndCloseJob(jobName, innerPins);
                facts["beforeInjection"] = new
                {
                    hostAlive = host.Alive, rootAlive = root.Alive, hungAlive = hung?.Alive,
                    initialCensus, census, registeredInnerIdentities, queryHandlesClosedBeforeInjection = true,
                    noMoreSpawnsAfterReady = true, frozenWorker = Path.GetFileName(main),
                    pins = pins.Select(pin => pin.Evidence()).ToArray(),
                    systemConsoleCount = systemConsoles.Count,
                    systemConsolePins = systemConsoles.Select(pin => pin.SystemConsoleEvidence(systemConsolePath, systemConsoleImage, expectedSid)).ToArray()
                };
                Require(host.Alive && innerPins.All(pin => pin.Alive) && expectedMemberIds.Distinct().Count() == innerPins.Length &&
                    initialCensus.ActiveProcesses == (uint)innerPins.Length && initialCensus.TotalProcesses == (uint)innerPins.Length &&
                    census.ActiveProcesses == (uint)innerPins.Length && census.TotalProcesses == (uint)innerPins.Length &&
                    initialCensus.MemberIds.Order().SequenceEqual(expectedMemberIds) && census.MemberIds.Order().SequenceEqual(expectedMemberIds),
                    "complete_inner_census_must_equal_principals_plus_qualified_system_consoles");
                Require(RootStarts(directory) == 1, "one_fixed_node_started");

                if (scenario == "host-death")
                {
                    // Only this retained original host object is terminated; the safety Job stays open.
                    host.Terminate();
                    injectionOccurred = true;
                    await host.JoinAsync(execution.Token);
                    await root.JoinAsync(execution.Token);
                    await hung!.JoinAsync(execution.Token);
                    foreach (var pin in systemConsoles) await pin.JoinAsync(execution.Token);
                    facts["hostDeath"] = new
                    {
                        intentionallyTerminatedHostOnly = true, queryHandlesClosedBeforeInjection = true,
                        postCrashOriginalJobActiveProcesses = (uint?)null, postCrashJobQueryUnavailable = true,
                        originalHostCompletionObserved = false, originalHostTreeExitObserved = false,
                        safetyJobStillOwned = true
                    };
                }
                else
                {
                    await commands.WriteLineAsync(graceful ? "graceful-stop" :
                        scenario switch { "root-exit" => "release-root", "stop-race" => "race-stop", _ => "fail-sink" });
                    injectionOccurred = true;
                    completed = await ReadAsync(input, execution.Token);
                    Require(completed.Value.GetProperty("kind").GetString() == "host-completed", "original_core_completion_receipt_required");
                    facts["completed"] = completed;
                    var cleanup = completed.Value.GetProperty("cleanup");
                    Require(cleanup.GetProperty("treeExit").GetProperty("activeProcesses").GetUInt32() == 0, "original_host_tree_active_zero_required");
                    Require(cleanup.GetProperty("stdout").GetProperty("eof").GetBoolean() && cleanup.GetProperty("stderr").GetProperty("eof").GetBoolean(), "original_core_dual_read_zero_eof_required");
                    Require(cleanup.GetProperty("stdout").GetProperty("readFailureType").ValueKind == JsonValueKind.Null &&
                        cleanup.GetProperty("stderr").GetProperty("readFailureType").ValueKind == JsonValueKind.Null, "core_read_errors_are_not_eof");
                    if (graceful)
                    {
                        var grace = completed.Value.GetProperty("graceful");
                        Require(completed.Value.GetProperty("sameStopTask").GetBoolean() &&
                            completed.Value.GetProperty("repeatAnchorUnchanged").GetBoolean(), "graceful_one_task_and_first_anchor");
                        Require(grace.GetProperty("frameWrites").GetInt32() == 1 && grace.GetProperty("writeJoined").GetBoolean(), "original_frame_task_once_and_joined");
                        Require(grace.GetProperty("ownerReleasedTreeActive").GetUInt32() == 0, "owner_release_requires_actual_original_tree_zero");
                        if (scenario == "graceful-cooperate")
                            Require(completed.Value.GetProperty("completionSucceeded").GetBoolean() && grace.GetProperty("verified").GetBoolean() &&
                                grace.GetProperty("frameSent").GetBoolean() && grace.GetProperty("forceCalls").GetInt32() == 0 &&
                                cleanup.GetProperty("rootExit").GetProperty("exitCode").GetUInt32() == 0, "cooperation_requires_real_flush_root_zero_tree_zero_eof_force_zero");
                        else
                        {
                            Require(!completed.Value.GetProperty("completionSucceeded").GetBoolean() && !grace.GetProperty("verified").GetBoolean() &&
                                grace.GetProperty("forceCalls").GetInt32() == 1 && grace.GetProperty("failure").ValueKind == JsonValueKind.String,
                                "fallback_cleanup_must_not_upgrade_cooperation_failure");
                            if (scenario is "graceful-ignore" or "graceful-root-hung")
                            {
                                var window = completed.Value.GetProperty("withinWindow");
                                Require(window.GetProperty("pending").GetBoolean() && window.GetProperty("forceCalls").GetInt32() == 0 &&
                                    window.GetProperty("activeProcesses").GetUInt32() > 0 &&
                                    window.GetProperty("tick").GetInt64() >= grace.GetProperty("requestedTick").GetInt64() + 28_000 &&
                                    window.GetProperty("tick").GetInt64() < grace.GetProperty("deadlineTick").GetInt64() &&
                                    grace.GetProperty("forceTick").GetInt64() >= grace.GetProperty("deadlineTick").GetInt64(), "real_first_thirty_second_window_before_force");
                                Require(window.GetProperty("processSignaled").GetBoolean() == (scenario == "graceful-root-hung"), "root_observer_must_not_force_on_cooperative_zero_root");
                                Require(grace.GetProperty("failure").GetString() == "deadline", "deadline_failure_sticky");
                            }
                            if (scenario == "graceful-nonzero")
                                Require(cleanup.GetProperty("rootExit").GetProperty("exitCode").GetUInt32() == 23 &&
                                    grace.GetProperty("failure").GetString() == "worker_nonzero", "nonzero_root_cannot_be_hidden_by_stop_requested");
                            if (scenario is "graceful-nonzero" or "graceful-hard-stop" or "graceful-sink-failure")
                                Require(grace.GetProperty("hardPreempt").GetBoolean() &&
                                    grace.GetProperty("forceTick").GetInt64() < grace.GetProperty("deadlineTick").GetInt64(), "hard_fault_preempts_same_owner_before_deadline");
                            if (scenario == "graceful-sink-failure")
                                Require(cleanup.GetProperty("stdout").GetProperty("sinkFailureType").GetString() == "IOException" &&
                                    completed.Value.GetProperty("sinkThrows").GetInt32() == 1, "graceful_sink_fault_drains_and_preempts");
                        }
                    }
                    else if (scenario == "sink-failure")
                    {
                        Require(!completed.Value.GetProperty("completionSucceeded").GetBoolean(), "sink_fault_must_fail_completion");
                        Require(cleanup.GetProperty("stdout").GetProperty("sinkFailureType").GetString() == "IOException" &&
                            completed.Value.GetProperty("sinkThrows").GetInt32() == 1, "one_real_sink_failure_then_discard");
                    }
                    else Require(completed.Value.GetProperty("completionSucceeded").GetBoolean(), "normal_host_cleanup_must_complete");
                    if (scenario == "stop-race")
                        Require(completed.Value.GetProperty("sameStopTask").GetBoolean() && completed.Value.GetProperty("secondStartRejected").GetBoolean(), "one_generation_shared_stop_and_reject_second_start");
                    foreach (var pin in pins.Concat(systemConsoles)) await pin.JoinAsync(execution.Token);
                }
                safetyExit = await safety.WaitForTreeExitAsync(execution.Token);
                var finalSafety = safety.Inspect();
                Require(safetyExit.ActiveProcesses == 0 && finalSafety.TotalProcesses == (uint)(expectedPrincipalPins + systemConsoles.Count) && pins.Count == expectedPrincipalPins,
                    "safety_exact_census_principals_and_all_qualified_system_consoles");
            }
        }
        catch (Exception failure) { failures.Add(failure.GetType().Name + ": " + failure.Message); }
        finally
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            try
            {
                if (safety is not null)
                {
                    var tree = safety.WaitForTreeExitAsync();
                    if (safetyExit is null && !tree.IsCompleted)
                    {
                        // A failed round may be rescued, but the rescue never counts as a passing containment proof.
                        guardianUsed = true;
                        safety.Force();
                    }
                    safetyExit ??= await tree.WaitAsync(cleanup.Token);
                    foreach (var pin in pins.Concat(systemConsoles)) await pin.JoinAsync(cleanup.Token);
                    allPinsJoined = pins.Concat(systemConsoles).All(pin => !pin.Alive && pin.Joined);
                    if (hostStdout is not null) output = await hostStdout.WaitAsync(cleanup.Token);
                    if (hostStderr is not null) errorOutput = await hostStderr.WaitAsync(cleanup.Token);
                    var accounting = safety.Inspect();
                    finalSafetyAccounting = new { accounting.ActiveProcesses, accounting.TotalProcesses,
                        originalSafetyJob = safety.JobName, distinctFromHostOwnedJob = true };
                }
            }
            catch (Exception failure) { failures.Add("cleanup " + failure.GetType().Name + ": " + failure.Message); }
            facts["cleanup"] = new
            {
                guardianUsed, injectionOccurred, allPinsJoined, expectedPins = expectedPrincipalPins + systemConsoles.Count,
                observedPins = pins.Count + systemConsoles.Count, principalExpectedPins = expectedPrincipalPins,
                principalObservedPins = pins.Count, systemConsoleCount = systemConsoles.Count, safetyTreeExit = safetyExit,
                safetyAccounting = finalSafetyAccounting,
                stdout = output, stderr = errorOutput, pins = pins.Select(pin => pin.Evidence()).ToArray(),
                systemConsolePins = systemConsoles.Select(pin => pin.SystemConsoleEvidence(systemConsolePath, systemConsoleImage, expectedSid)).ToArray(),
                workerStarts = RootStarts(directory)
            };
            try { safety?.Dispose(); }
            catch (Exception failure) { failures.Add("dispose " + failure.GetType().Name + ": " + failure.Message); }
            foreach (var pin in pins) pin.Dispose();
            foreach (var pin in systemConsoles) pin.Dispose();
        }
        if (guardianUsed) failures.Add("External safety guardian was used; containment was not proven.");
        facts["passed"] = failures.Count == 0;
        facts["failures"] = failures;
        return WriteCase(directory, facts);
    }

    private static async Task<int> RunHostAsync(string[] args)
    {
        string scenario = args[1], directory = args[2], prefix = args[3];
        long deadlineTick = long.Parse(args[8], CultureInfo.InvariantCulture);
        int cleanupMs = int.Parse(args[9], CultureInfo.InvariantCulture);
        using var execution = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, deadlineTick - Environment.TickCount64)));
        using var pipe = new NamedPipeClientStream(".", prefix + "-control", PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(execution.Token);
        using var input = new StreamReader(pipe, Utf8, false, leaveOpen: true);
        await using var output = new StreamWriter(pipe, Utf8, leaveOpen: true) { AutoFlush = true };
        await WriteAsync(output, new { kind = "host-waiting" });
        Require(await input.ReadLineAsync(execution.Token) == "start", "explicit_observer_start_required");
        using var rawOut = new FileStream(Path.Combine(directory, "worker.stdout.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var rawErr = new FileStream(Path.Combine(directory, "worker.stderr.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        bool failSink = false;
        int sinkThrows = 0;
        bool graceful = scenario.StartsWith("graceful-", StringComparison.Ordinal);
        string[] workerArguments = graceful ? [args[7], Executable, directory, prefix, args[4], args[5], scenario] :
            [args[7], Executable, directory, prefix, args[4], args[5]];
        using var session = new ContainedWorkerSession(args[6], workerArguments, directory,
            bytes =>
            {
                if (Volatile.Read(ref failSink)) { Interlocked.Increment(ref sinkThrows); throw new IOException("fixture_stdout_sink_failure"); }
                rawOut.Write(bytes.Span);
                if (graceful) rawOut.Flush();
            }, bytes => rawErr.Write(bytes.Span));
        try { session.Start(); }
        catch (Exception failure)
        {
            await WriteAsync(output, new { kind = "host-start", startSucceeded = false, startFailureType = failure.GetType().Name,
                workerStarts = RootStarts(directory), completionCompleted = session.Completion.IsCompleted });
            return 0;
        }
        var prepared = session.Inspect() ?? throw new InvalidDataException("actual_core_original_inspection_missing");
        await WriteAsync(output, new { kind = "host-start", startSucceeded = true, startFailureType = (string?)null,
            root = ToFact(prepared.EngineIdentity), jobName = session.JobName, completionCompleted = session.Completion.IsCompleted,
            prepared.ActiveProcesses, prepared.TotalProcesses, prepared.Authorized, prepared.JobHandleFlags, prepared.ProcessHandleFlags });
        Require(!session.Completion.IsCompleted, "core_completion_pending_at_real_ready_gate");
        string? command = await input.ReadLineAsync(execution.Token);
        bool secondStartRejected = false, sameStopTask = false;
        Task? firstStop = null;
        bool repeatAnchorUnchanged = false;
        object? withinWindow = null;
        if (command == "graceful-stop" && graceful)
        {
            if (scenario == "graceful-sink-failure") Volatile.Write(ref failSink, true);
            firstStop = session.GracefulStopAsync();
            var firstGrace = session.GracefulObservation;
            sameStopTask = ReferenceEquals(firstStop, session.GracefulStopAsync());
            if (scenario is "graceful-ignore" or "graceful-root-hung")
            {
                await Task.Delay(1000, execution.Token);
                sameStopTask &= ReferenceEquals(firstStop, session.GracefulStopAsync());
                long remaining = firstGrace.DeadlineTick!.Value - Environment.TickCount64 - 1000;
                if (remaining > 0) await Task.Delay(TimeSpan.FromMilliseconds(remaining), execution.Token);
                var actual = session.Inspect() ?? throw new InvalidDataException("graceful_window_original_owner_missing");
                withinWindow = new { tick = Environment.TickCount64, pending = !firstStop.IsCompleted,
                    actual.ActiveProcesses, actual.ProcessSignaled, session.GracefulObservation.ForceCalls };
            }
            else if (scenario == "graceful-hard-stop")
            {
                while (!session.GracefulObservation.FrameSent && !firstStop.IsCompleted)
                    await Task.Delay(10, execution.Token);
                Require(session.GracefulObservation.FrameSent, "hard_stop_after_actual_original_frame_flush");
                sameStopTask &= ReferenceEquals(firstStop, session.StopAsync());
            }
            repeatAnchorUnchanged = firstGrace.RequestedTick == session.GracefulObservation.RequestedTick &&
                firstGrace.DeadlineTick == session.GracefulObservation.DeadlineTick;
        }
        else if (command == "race-stop")
        {
            try { session.Start(); } catch (InvalidOperationException) { secondStartRejected = true; }
            await SendRootAsync(session, "exit", execution.Token);
            firstStop = session.StopAsync();
            sameStopTask = ReferenceEquals(firstStop, session.StopAsync());
        }
        else if (command == "release-root") await SendRootAsync(session, "exit", execution.Token);
        else if (command == "fail-sink")
        {
            Volatile.Write(ref failSink, true);
            await SendRootAsync(session, "flood", execution.Token);
        }
        else throw new InvalidDataException("original_host_command_missing");
        bool succeeded = false;
        string? completionFailureType = null;
        try
        {
            await session.Completion.WaitAsync(execution.Token);
            if (firstStop is not null) await firstStop.WaitAsync(execution.Token);
            succeeded = true;
        }
        catch (Exception failure) { completionFailureType = failure.GetType().Name; }
        var cleanupFacts = CleanupFacts(session.CleanupObservation);
        await WriteAsync(output, new { kind = "host-completed", completionSucceeded = succeeded, completionFailureType,
            cleanup = cleanupFacts, sameStopTask, secondStartRejected, sinkThrows = Volatile.Read(ref sinkThrows),
            graceful = session.GracefulObservation, repeatAnchorUnchanged, withinWindow });
        if (!succeeded && scenario != "sink-failure" && !graceful)
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            try { await session.StopAsync().WaitAsync(cleanup.Token); } catch { }
        }
        return 0;
    }

    private static async Task<int> RunHungAsync(string[] args)
    {
        string directory = args[1], prefix = args[2];
        using var permanent = new ManualResetEvent(false);
        using var observer = Native.OpenDuplicateTarget(new(int.Parse(args[3], CultureInfo.InvariantCulture), args[4]));
        var proof = Native.DuplicateSelfTo(observer);
        using var marker = new FileStream(Path.Combine(directory, "hung.marker"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using (var text = new StreamWriter(marker, Utf8, leaveOpen: true)) text.Write("hung-without-stdin-output-or-timeout-exit");
        Console.WriteLine("hung-stdout");
        Console.Error.WriteLine("hung-stderr");
        using var pipe = new NamedPipeClientStream(".", prefix + "-hung", PipeDirection.Out, PipeOptions.Asynchronous);
        await pipe.ConnectAsync();
        await using var output = new StreamWriter(pipe, Utf8, leaveOpen: true) { AutoFlush = true };
        await WriteAsync(output, proof);
        // READY is the last I/O: even a later broken pipe cannot release this existing gate.
        permanent.WaitOne();
        throw new InvalidOperationException("The permanent hung gate must never be released.");
    }

    private static async Task<int> RunStopBeforeStartAsync(string directory, string node, string main, int executionMs, int cleanupMs, bool graceful = false)
    {
        var failures = new List<string>();
        var facts = new Dictionary<string, object?> { ["scenario"] = graceful ? "graceful-before-start" : "stop-before-start" };
        using var execution = new CancellationTokenSource(executionMs);
        long deadlineTick = checked(Environment.TickCount64 + executionMs);
        JobProcess? safety = null;
        ProcessPin? child = null;
        Task<StreamEnd>? stdout = null, stderr = null;
        StreamEnd? originalOut = null, originalError = null;
        JobTreeExit? treeExit = null;
        object? accounting = null;
        bool guardianUsed = false;
        try
        {
            string fixedImage = Native.FileIdentity(Executable);
            safety = JobProcess.Prepare(Executable,
                [graceful ? "graceful-before-start-child" : "stop-before-start-child", directory, node, main, deadlineTick.ToString(CultureInfo.InvariantCulture)], directory);
            child = ProcessPin.OpenQualified(ToFact(safety.EngineIdentity), Executable, fixedImage, safety.JobName);
            stdout = DrainAsync(safety.StandardOutput, capture: true);
            stderr = DrainAsync(safety.StandardError, capture: true);
            Require(safety.AuthorizeOnce(), "stop_before_start_child_authorize_once");
            var rootExit = await safety.WaitForProcessExitAsync(execution.Token);
            treeExit = await safety.WaitForTreeExitAsync(execution.Token);
            await child.JoinAsync(execution.Token);
            originalOut = await stdout.WaitAsync(execution.Token);
            originalError = await stderr.WaitAsync(execution.Token);
            var observed = safety.Inspect();
            accounting = new { observed.ActiveProcesses, observed.TotalProcesses, originalSafetyJob = safety.JobName };
            Require(originalOut.Eof && originalError.Eof && originalOut.ErrorType is null && originalError.ErrorType is null && originalError.BytesRead == 0,
                "stop_before_start_child_real_dual_eof_required");
            using var document = JsonDocument.Parse(Convert.FromBase64String(originalOut.Utf8Base64!));
            var result = document.RootElement.Clone();
            facts["child"] = result;
            facts["graceful"] = result.GetProperty("graceful").Clone();
            foreach (var name in new[] { "stopped", "sameStopTask", "secondStartRejected", "failureType", "workerStarts", "cleanup" })
                facts[name] = result.GetProperty(name).Clone();
            foreach (var failure in result.GetProperty("failures").EnumerateArray()) failures.Add("child " + failure.GetString());
            Require(observed.TotalProcesses == 1 && observed.ActiveProcesses == 0 && treeExit.ActiveProcesses == 0,
                "stop_before_start_historical_census_must_contain_only_child_fixture_no_prepared_node");
            Require(rootExit.ExitCode == 0 && child.ExitCode == 0 && result.GetProperty("passed").GetBoolean(),
                "stop_before_start_original_child_must_naturally_complete");
        }
        catch (Exception failure) { failures.Add(failure.GetType().Name + ": " + failure.Message); }
        finally
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            if (safety is not null)
            {
                try
                {
                    var tree = safety.WaitForTreeExitAsync();
                    if (treeExit is null && !tree.IsCompleted) { guardianUsed = true; safety.Force(); }
                    treeExit ??= await tree.WaitAsync(cleanup.Token);
                    if (child is not null) await child.JoinAsync(cleanup.Token);
                    if (stdout is not null) originalOut ??= await stdout.WaitAsync(cleanup.Token);
                    if (stderr is not null) originalError ??= await stderr.WaitAsync(cleanup.Token);
                    var observed = safety.Inspect();
                    accounting = new { observed.ActiveProcesses, observed.TotalProcesses, originalSafetyJob = safety.JobName };
                }
                catch (Exception failure) { failures.Add("cleanup " + failure.GetType().Name + ": " + failure.Message); }
                facts["boundary"] = new { guardianUsed, originalChild = child?.Evidence(), safetyTreeExit = treeExit,
                    accounting, stdout = originalOut, stderr = originalError, factsScope = "original-safety-job-historical-census-not-marker-inference" };
                try { safety.Dispose(); }
                catch (Exception failure) { failures.Add("dispose " + failure.GetType().Name + ": " + failure.Message); }
            }
            child?.Dispose();
        }
        if (guardianUsed) failures.Add("Stop-before-start test required external guardian containment.");
        facts["passed"] = failures.Count == 0;
        facts["failures"] = failures;
        return WriteCase(directory, facts);
    }

    private static async Task<int> RunStopBeforeStartChildAsync(string directory, string node, string main, long deadlineTick, bool graceful = false)
    {
        var failures = new List<string>();
        using var execution = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, deadlineTick - Environment.TickCount64)));
        using var session = new ContainedWorkerSession(node, [main], directory, _ => { }, _ => { });
        bool secondStartRejected = false, sameStopTask = false, stopped = false;
        string? failureType = null;
        try
        {
            var first = graceful ? session.GracefulStopAsync() : session.StopAsync();
            sameStopTask = ReferenceEquals(first, graceful ? session.GracefulStopAsync() : session.StopAsync());
            await first.WaitAsync(execution.Token);
            await session.Completion.WaitAsync(execution.Token);
            stopped = true;
            try { session.Start(); } catch (InvalidOperationException) { secondStartRejected = true; }
            Require(secondStartRejected && sameStopTask && session.Inspect() is null && session.JobName is null && RootStarts(directory) == 0, "stop_before_start_must_seal_without_prepare_or_authorize");
        }
        catch (Exception failure) { failureType = failure.GetType().Name; failures.Add(failureType + ": " + failure.Message); }
        var facts = new { scenario = "stop-before-start-child", passed = failures.Count == 0, failures, stopped,
            sameStopTask, secondStartRejected, failureType, workerStarts = RootStarts(directory), cleanup = CleanupFacts(session.CleanupObservation),
            graceful = session.GracefulObservation };
        WriteNew(Path.Combine(directory, "stop-before-start-child-evidence.json"), facts);
        Console.WriteLine(JsonSerializer.Serialize(facts, Json));
        return failures.Count == 0 ? 0 : 1;
    }

    private static async Task<int> RunWorkerStopAsync(string[] args)
    {
        string node = Path.GetFullPath(args[1]), main = Path.GetFullPath(args[2]);
        string configPath = Path.GetFullPath(args[3]), directory = Path.GetFullPath(args[4]);
        int executionMs = int.Parse(args[5], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        Require(executionMs > 0 && cleanupMs > 0, "worker_stop_positive_bounds");
        using var configuration = JsonDocument.Parse(File.ReadAllBytes(configPath));
        var configured = configuration.RootElement;
        string phase = configured.GetProperty("phase").GetString()!;
        Require(phase is "original" or "recover", "worker_stop_fixed_phase");
        string basePath = Path.GetFullPath(configured.GetProperty("engineControlBasePath").GetString()!);
        Require(string.Equals(basePath, Path.Combine(directory, "engine-base-" + phase + ".json"), StringComparison.OrdinalIgnoreCase),
            "worker_stop_control_base_exact_path");
        using var execution = new CancellationTokenSource(executionMs);
        using var observation = CancellationTokenSource.CreateLinkedTokenSource(execution.Token);
        string pipeName = "zeb-worker-stop-" + Guid.NewGuid().ToString("N");
        using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        WriteNew(basePath, new { pipe = pipeName, harness = Native.Identity(new IntPtr(-1)),
            fixtureDeadlineUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + executionMs });
        using var rawOut = new FileStream(Path.Combine(directory, "host-" + phase + ".stdout.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var rawErr = new FileStream(Path.Combine(directory, "host-" + phase + ".stderr.bin"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        var session = new ContainedWorkerSession(node, [main, configPath], directory,
            bytes => rawOut.Write(bytes.Span), bytes => rawErr.Write(bytes.Span));
        var pins = new List<ProcessPin>();
        var failures = new List<string>();
        Task<ProcessPin>? observedEngine = null;
        Task? stopped = null;
        ProcessPin? engine = null;
        bool explicitStop = false, guardianUsed = false, joined = false;
        object? beforeStop = null;
        bool interruptSent = false;
        object? beforeInterrupt = null;
        ProcessFact? root = null;
        try
        {
            string? start = await Console.In.ReadLineAsync(execution.Token);
            Require(start is not null, "worker_stop_explicit_start_required");
            using var startCommand = JsonDocument.Parse(start!);
            Require(startCommand.RootElement.GetProperty("kind").GetString() == "start", "worker_stop_one_explicit_start");
            session.Start();
            var original = session.Inspect() ?? throw new InvalidDataException("worker_stop_original_root_missing");
            root = ToFact(original.EngineIdentity);
            pins.Add(ProcessPin.OpenQualified(root, node, Native.FileIdentity(node), session.JobName!));
            observedEngine = ObserveEngineAsync(pipe, session,
                configured.GetProperty("engineBinaryPath").GetString()!, observation.Token);
            Console.WriteLine(JsonSerializer.Serialize(new { kind = "host-start", root, jobName = session.JobName }, Json));
            Console.Out.Flush();
            string? commandText = await Console.In.ReadLineAsync(execution.Token);
            Require(commandText is not null, "worker_stop_command_eof");
            using var command = JsonDocument.Parse(commandText!);
            var request = command.RootElement;
            Require(request.GetProperty("kind").GetString() is "stop" or "cleanup" or "interrupt", "worker_stop_fixed_command");
            Require(request.GetProperty("root").Deserialize<ProcessFact>(Json) == root && pins[0].Alive,
                "worker_stop_same_live_root");
            bool interruptRequested = request.GetProperty("kind").GetString() == "interrupt";
            if (interruptRequested)
                Require(configured.TryGetProperty("allowInterrupt", out var allow) && allow.ValueKind == JsonValueKind.True &&
                    request.GetProperty("engine").ValueKind == JsonValueKind.Object, "worker_stop_interrupt_explicit_fixture_opt_in");
            explicitStop = request.GetProperty("kind").GetString() == "stop";
            guardianUsed = request.GetProperty("kind").GetString() == "cleanup";
            if ((explicitStop || interruptRequested) && request.GetProperty("engine").ValueKind != JsonValueKind.Null)
            {
                engine = await observedEngine.WaitAsync(execution.Token);
                pins.Add(engine);
                Require(request.GetProperty("engine").Deserialize<ProcessFact>(Json) == engine.Identity && engine.Alive,
                    "worker_stop_original_authorized_engine");
                var helper = request.GetProperty("supervisor").Deserialize<ProcessFact>(Json)
                    ?? throw new InvalidDataException("worker_stop_supervisor_identity_required");
                string helperPath = configured.GetProperty("bridge").GetProperty("helperPath").GetString()!;
                pins.Add(ProcessPin.OpenQualified(helper, helperPath, Native.FileIdentity(helperPath), session.JobName!));
            }
            else if (explicitStop) Require(!observedEngine.IsCompletedSuccessfully, "worker_stop_unexpected_engine_on_recovery");
            var beforeCommand = new { pins = pins.Select(pin => pin.Evidence()).ToArray(),
                census = Native.ObserveAndCloseJob(session.JobName!, pins), factsScope = "original-host-job-not-native-journal-terminal" };
            if (interruptRequested)
            {
                beforeInterrupt = beforeCommand;
                Require(stopped is null && !session.Completion.IsCompleted, "worker_stop_interrupt_before_host_cleanup");
                byte[] frame = Utf8.GetBytes("ZEB_FIXTURE_INTERRUPT_V1\n");
                await session.StandardInput.WriteAsync(frame, execution.Token);
                await session.StandardInput.FlushAsync(execution.Token);
                interruptSent = true;
                Console.WriteLine(JsonSerializer.Serialize(new { kind = "host-interrupt-sent", root, interruptSent, beforeInterrupt }, Json));
                Console.Out.Flush();
                // Keep the same live Node/Host and all pre-qualified handles while the parent reads the native journal.
                string? finalText = await Console.In.ReadLineAsync(execution.Token);
                Require(finalText is not null, "worker_stop_interrupt_final_command_eof");
                using var finalCommand = JsonDocument.Parse(finalText!);
                var final = finalCommand.RootElement;
                Require(final.GetProperty("kind").GetString() is "stop" or "cleanup", "worker_stop_interrupt_one_final_command");
                Require(final.GetProperty("root").Deserialize<ProcessFact>(Json) == root && pins[0].Alive,
                    "worker_stop_interrupt_same_original_live_node");
                explicitStop = final.GetProperty("kind").GetString() == "stop";
                guardianUsed = !explicitStop;
                if (explicitStop)
                {
                    Require(final.GetProperty("engine").ValueKind == JsonValueKind.Null &&
                        final.GetProperty("supervisor").ValueKind == JsonValueKind.Null, "worker_stop_interrupt_no_postmortem_reopen");
                    Require(pins.Skip(1).All(pin => !pin.Alive), "worker_stop_interrupt_original_native_pins_signaled");
                }
                beforeStop = new { pins = pins.Select(pin => pin.Evidence()).ToArray(),
                    census = Native.ObserveAndCloseJob(session.JobName!, [pins[0]]),
                    factsScope = "original-retained-pins-after-native-interrupt-before-final-host-stop" };
            }
            else beforeStop = beforeCommand;
            stopped = session.StopAsync();
            await stopped.WaitAsync(execution.Token);
        }
        catch (Exception error) { failures.Add(error.GetType().Name + ": " + error.Message); }
        finally
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            if (stopped is null) { guardianUsed = true; stopped = session.StopAsync(); }
            try
            {
                await stopped.WaitAsync(cleanup.Token);
                observation.Cancel();
                pipe.Dispose();
                if (observedEngine is not null)
                {
                    try
                    {
                        var actual = await observedEngine.WaitAsync(cleanup.Token);
                        if (!pins.Contains(actual)) { engine = actual; pins.Add(actual); }
                    }
                    catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException or IOException) { }
                }
                foreach (var pin in pins) await pin.JoinAsync(cleanup.Token);
                var facts = session.CleanupObservation;
                joined = facts.TreeExit?.ActiveProcesses == 0 && facts.RootExit is not null && facts.Stdout.Eof && facts.Stderr.Eof;
                Require(joined, "worker_stop_original_root_tree_and_both_host_eof_required");
                rawOut.Flush(true); rawErr.Flush(true);
            }
            catch (Exception error) { guardianUsed = true; failures.Add("cleanup " + error.GetType().Name + ": " + error.Message); }
            var receipt = new { kind = "host-completed", phase, root, explicitStop, guardianUsed, beforeStop, interruptSent, beforeInterrupt,
                engineObserved = engine is null ? 0 : 1, allPinsJoined = joined && pins.All(pin => pin.Joined),
                pins = pins.Select(pin => pin.Evidence()).ToArray(), cleanup = CleanupFacts(session.CleanupObservation),
                passed = explicitStop && !guardianUsed && joined && failures.Count == 0, failures };
            WriteNew(Path.Combine(directory, "host-stop-" + phase + ".json"), receipt);
            Console.WriteLine(JsonSerializer.Serialize(receipt, Json)); Console.Out.Flush();
            foreach (var pin in pins) pin.Dispose();
            if (!joined) Environment.Exit(2); // Guardian failure closes only this original host and its owning Job.
            session.Dispose();
        }
        return failures.Count == 0 && explicitStop && !guardianUsed ? 0 : 1;
    }

    private static async Task<ProcessPin> ObserveEngineAsync(NamedPipeServerStream pipe, ContainedWorkerSession session,
        string image, CancellationToken token)
    {
        await pipe.WaitForConnectionAsync(token);
        Native.Check(Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint pid), "worker_stop_actual_engine_pipe_peer");
        using var reader = new StreamReader(pipe, Utf8, false, leaveOpen: true);
        string? line = await reader.ReadLineAsync(token);
        Require(line is not null, "worker_stop_engine_hello_required");
        using var hello = JsonDocument.Parse(line!);
        Require(hello.RootElement.GetProperty("stage").GetString() == "loaded" &&
            hello.RootElement.GetProperty("role").GetString() == "engine", "worker_stop_engine_loaded");
        var identity = hello.RootElement.GetProperty("identity").Deserialize<ProcessFact>(Json)
            ?? throw new InvalidDataException("worker_stop_engine_identity");
        Require(identity.Pid == pid, "worker_stop_actual_peer_pid");
        return ProcessPin.OpenQualified(identity, image, Native.FileIdentity(image), session.JobName!);
    }

    private static async Task<int> RunNestedAsync(string[] args)
    {
        string directory = Path.GetFullPath(args[4]);
        int executionMs = int.Parse(args[5], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[6], CultureInfo.InvariantCulture);
        string original = Path.Combine(AppContext.BaseDirectory, "WindowsSessionFixture.exe");
        Require(File.Exists(original) && File.Exists(Path.Combine(AppContext.BaseDirectory, "WindowsSessionFixture.dll")), "fixed_original_nested_fixture_payload_missing");
        using var execution = new CancellationTokenSource(executionMs);
        using var output = Console.OpenStandardOutput();
        using var error = Console.OpenStandardError();
        using var callerInput = Console.OpenStandardInput();
        using var relayCancellation = new CancellationTokenSource();
        using var session = new ContainedWorkerSession(original, args, directory, bytes => output.Write(bytes.Span), bytes => error.Write(bytes.Span));
        Task<RelayEnd>? relay = null;
        RelayEnd? relayEnd = null;
        var failures = new List<string>();
        string? startFailureType = null;
        ProcessFact? originalRoot = null;
        string? jobName = null;
        try
        {
            try { session.Start(); }
            catch (Exception failure) { startFailureType = failure.GetType().Name; throw; }
            originalRoot = ToFact((session.Inspect() ?? throw new InvalidDataException("nested_original_root_missing")).EngineIdentity);
            jobName = session.JobName;
            relay = RelayAsync(callerInput, session.StandardInput, relayCancellation.Token);
            await session.Completion.WaitAsync(execution.Token);
        }
        catch (Exception failure) { failures.Add(failure.GetType().Name + ": " + failure.Message); }
        finally
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            if (relay is not null)
            {
                // A failed root may strand caller input; preserve cancellation/close separately from actual EOF.
                if (!relay.IsCompleted && session.Completion.IsCompleted)
                {
                    relayCancellation.Cancel();
                    callerInput.Dispose();
                }
                try { relayEnd = await relay.WaitAsync(cleanup.Token); }
                catch (Exception failure) { failures.Add("stdin relay " + failure.GetType().Name + ": " + failure.Message); }
            }
            if (failures.Count != 0 && startFailureType is null)
            {
                try { await session.StopAsync().WaitAsync(cleanup.Token); }
                catch (Exception failure) { failures.Add("stop " + failure.GetType().Name + ": " + failure.Message); }
            }
            var observed = session.CleanupObservation;
            if (startFailureType is null)
            {
                if (observed.TreeExit?.ActiveProcesses != 0 || !observed.Stdout.Eof || !observed.Stderr.Eof)
                    failures.Add("Nested core did not preserve the original tree and both actual output EOF facts.");
                if (relayEnd is not { ActualEof: true, TargetClosedAfterActualEof: true, ErrorType: null })
                    failures.Add("Nested input relay did not join at the caller's real EOF.");
            }
            WriteNew(Path.Combine(directory, "windows-service-host-h4.json"), new
            {
                scenario = "nested-original-fixture", rootKind = "original-WindowsSessionFixture-not-Node", originalRoot,
                originalExecutable = original, originalArguments = args, jobName, startSucceeded = startFailureType is null,
                startFailureType, completionCompleted = session.Completion.IsCompleted,
                cleanup = CleanupFacts(observed), inputRelay = relayEnd, inputRelayJoined = relay?.IsCompleted ?? false,
                protocolBytesTransformed = false, guardianUsed = false, passed = failures.Count == 0, failures
            });
        }
        return failures.Count == 0 ? 0 : 1;
    }

    private static async Task<int> RunMissingPayloadAsync(string[] args)
    {
        string product = Path.GetFullPath(args[1]), directory = Path.GetFullPath(args[2]);
        int executionMs = int.Parse(args[3], CultureInfo.InvariantCulture), cleanupMs = int.Parse(args[4], CultureInfo.InvariantCulture);
        bool startup = args[0] == "product-startup";
        if (!startup) Require(!File.Exists(Path.Combine(Path.GetDirectoryName(product)!, "runtime", "node.exe")) &&
            !File.Exists(Path.Combine(Path.GetDirectoryName(product)!, "app", "main.mjs")), "negative_product_layout_must_have_no_fixed_payload");
        using var execution = new CancellationTokenSource(executionMs);
        var facts = new Dictionary<string, object?> { ["scenario"] = startup ? args[5] : "missing-fixed-payload" };
        var failures = new List<string>();
        JobProcess? job = null;
        ProcessPin? pin = null;
        Task<StreamEnd>? stdout = null, stderr = null;
        JobTreeExit? treeExit = null;
        bool guardianUsed = false;
        DirectoryInfo? deniedParent = null;
        DirectorySecurity? parentSecurity = null;
        string? deniedSddl = null;
        try
        {
            if (startup && args[5] is "deny-parent" or "deny-grandparent")
            {
                deniedParent = new DirectoryInfo(Path.Combine(directory, "external"));
                if (args[5] == "deny-parent") deniedParent = new DirectoryInfo(Path.Combine(deniedParent.FullName, "nested"));
                parentSecurity = deniedParent.GetAccessControl();
                using var identity = WindowsIdentity.GetCurrent();
                var raw = new RawSecurityDescriptor(parentSecurity.GetSecurityDescriptorSddlForm(AccessControlSections.All));
                // FileSystemAccessRule strips SYNCHRONIZE from Deny; preserve the full requested mask in this real fixture.
                raw.DiscretionaryAcl!.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessDenied, 0x001000A0, identity.User!, false, null));
                var denied = new DirectorySecurity();
                byte[] descriptor = new byte[raw.BinaryLength];
                raw.GetBinaryForm(descriptor, 0);
                denied.SetSecurityDescriptorBinaryForm(descriptor, AccessControlSections.Access);
                deniedParent.SetAccessControl(denied);
                deniedSddl = deniedParent.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All);
                var applied = new RawSecurityDescriptor(deniedSddl);
                Require(applied.DiscretionaryAcl![0] is CommonAce ace && ace.AceQualifier == AceQualifier.AccessDenied &&
                    ace.AccessMask == 0x001000A0 && identity.User!.Equals(ace.SecurityIdentifier), "actual_full_mask_deny_required");
            }
            string fixedImage = Native.FileIdentity(product);
            job = JobProcess.Prepare(product, ["--console"], directory);
            pin = ProcessPin.OpenQualified(ToFact(job.EngineIdentity), product, fixedImage, job.JobName);
            stdout = DrainAsync(job.StandardOutput, capture: true);
            stderr = DrainAsync(job.StandardError, capture: true);
            Require(job.AuthorizeOnce(), "missing_payload_original_product_authorize_once");
            var rootExit = await job.WaitForProcessExitAsync(execution.Token);
            treeExit = await job.WaitForTreeExitAsync(execution.Token);
            await pin.JoinAsync(execution.Token);
            var observed = job.Inspect();
            var originalOut = await stdout.WaitAsync(execution.Token);
            var originalError = await stderr.WaitAsync(execution.Token);
            if (!startup) Require(rootExit.ExitCode == 2 && pin.ExitCode == 2 && observed.ActiveProcesses == 0 && observed.TotalProcesses == 1,
                "missing_payload_requires_actual_exit_two_and_zero_child_starts");
            Require(originalOut.Eof && originalError.Eof && originalOut.ErrorType is null && originalError.ErrorType is null && originalOut.BytesRead == 0,
                "missing_payload_requires_actual_dual_eof_and_empty_stdout");
            if (!startup) Require(Utf8.GetString(Convert.FromBase64String(originalError.Utf8Base64!)).Trim() == "worker_payload_unavailable", "missing_payload_diagnostic_must_not_include_paths");
            facts["product"] = new { exitCode = rootExit.ExitCode, observed.ActiveProcesses, observed.TotalProcesses, zeroChildStarts = observed.TotalProcesses == 1,
                root = ToFact(rootExit.Identity), stdout = originalOut, stderr = originalError, pin = pin.Evidence() };
        }
        catch (Exception failure) { failures.Add(failure.GetType().Name + ": " + failure.Message); }
        finally
        {
            using var cleanup = new CancellationTokenSource(cleanupMs);
            if (job is not null)
            {
                try
                {
                    if (treeExit is null)
                    {
                        var tree = job.WaitForTreeExitAsync();
                        if (!tree.IsCompleted) { guardianUsed = true; job.Force(); }
                        treeExit = await tree.WaitAsync(cleanup.Token);
                    }
                    if (pin is not null) await pin.JoinAsync(cleanup.Token);
                    if (stdout is not null) await stdout.WaitAsync(cleanup.Token);
                    if (stderr is not null) await stderr.WaitAsync(cleanup.Token);
                }
                catch (Exception failure) { failures.Add("cleanup " + failure.GetType().Name + ": " + failure.Message); }
                try { job.Dispose(); }
                catch (Exception failure) { failures.Add("dispose " + failure.GetType().Name + ": " + failure.Message); }
            }
            pin?.Dispose();
            if (deniedParent is not null && parentSecurity is not null)
            {
                // Check the product did not rewrite an external ACL before removing this fixture's own deny.
                facts["externalUnchanged"] = deniedParent.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All) == deniedSddl;
                var restore = new DirectorySecurity();
                restore.SetSecurityDescriptorSddlForm(parentSecurity.GetSecurityDescriptorSddlForm(AccessControlSections.All), AccessControlSections.Access);
                deniedParent.SetAccessControl(restore);
                facts["parentRestored"] = deniedParent.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All) ==
                    parentSecurity.GetSecurityDescriptorSddlForm(AccessControlSections.All);
            }
        }
        if (guardianUsed) failures.Add("Missing-payload test required external guardian containment.");
        facts["cleanup"] = new { guardianUsed, treeExit };
        facts["passed"] = failures.Count == 0;
        facts["failures"] = failures;
        return WriteCase(directory, facts);
    }

    private static async Task<RelayEnd> RelayAsync(Stream source, Stream target, CancellationToken token)
    {
        long bytes = 0;
        bool eof = false, closed = false;
        try
        {
            var buffer = new byte[4096];
            while (true)
            {
                int count = await source.ReadAsync(buffer, token);
                if (count == 0) { eof = true; break; }
                await target.WriteAsync(buffer.AsMemory(0, count), token);
                await target.FlushAsync(token);
                bytes += count;
            }
            target.Close();
            closed = true;
            return new(bytes, eof, closed, null, token.IsCancellationRequested);
        }
        catch (Exception failure) { return new(bytes, eof, closed, failure.GetType().Name, token.IsCancellationRequested); }
    }

    private static async Task SendRootAsync(ContainedWorkerSession session, string command, CancellationToken token)
    {
        await session.StandardInput.WriteAsync(Utf8.GetBytes(command + "\n"), token);
        await session.StandardInput.FlushAsync(token);
    }

    private static int RootStarts(string directory)
    {
        string path = Path.Combine(directory, "root-starts.ndjson");
        return File.Exists(path) ? File.ReadAllLines(path, Utf8).Length : 0;
    }

    private static object CleanupFacts(WorkerCleanupObservation observed) => new
    {
        rootExit = observed.RootExit is { } root ? new { identity = ToFact(root.Identity), root.ExitCode } : null,
        observed.TreeExit, observed.Stdout, observed.Stderr,
        factsScope = "original-core-root-tree-await-and-stream-read-zero-not-business-exit"
    };

    private static Task<StreamEnd> DrainAsync(Stream stream, bool capture = false) => Task.Run(async () =>
    {
        long bytes = 0;
        using var retained = new MemoryStream();
        try
        {
            var buffer = new byte[4096];
            while (true)
            {
                int count = await stream.ReadAsync(buffer);
                if (count == 0) return new StreamEnd(true, bytes, null, capture ? Convert.ToBase64String(retained.ToArray()) : null);
                bytes += count;
                if (capture)
                {
                    Require(bytes <= 4096, "bounded_negative_diagnostic_capture");
                    retained.Write(buffer, 0, count);
                }
            }
        }
        catch (Exception failure) { return new StreamEnd(false, bytes, failure.GetType().Name, capture ? Convert.ToBase64String(retained.ToArray()) : null); }
    });

    private static async Task<JsonElement> ReadAsync(StreamReader input, CancellationToken token)
    {
        string line = await input.ReadLineAsync(token) ?? throw new EndOfStreamException("Original fixture receipt ended early.");
        using var document = JsonDocument.Parse(line);
        return document.RootElement.Clone();
    }

    private static Task WriteAsync(StreamWriter output, object value) => output.WriteLineAsync(JsonSerializer.Serialize(value, Json));
    private static ProcessFact ToFact(ProcessIdentity identity) => new(identity.Pid, identity.CreationFileTime.ToString(CultureInfo.InvariantCulture));
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
    private static void WriteNew(string path, object value)
    {
        using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var writer = new StreamWriter(file, Utf8);
        writer.Write(JsonSerializer.Serialize(value, Json) + "\n");
    }
    private static int WriteCase(string directory, object facts)
    {
        WriteNew(Path.Combine(directory, "service-host-evidence.json"), facts);
        var document = JsonSerializer.SerializeToElement(facts, Json);
        Console.WriteLine(document.GetRawText());
        return document.GetProperty("passed").GetBoolean() ? 0 : 1;
    }

    private sealed record StreamEnd(bool Eof, long BytesRead, string? ErrorType, string? Utf8Base64 = null);
    private sealed record RelayEnd(long BytesForwarded, bool ActualEof, bool TargetClosedAfterActualEof, string? ErrorType, bool CancellationRequested);
    private sealed record ProcessFact(int Pid, string CreationFileTime);
    private sealed record HandleProof(ProcessFact Identity, string Handle, string Source);
    private sealed record JobCensus(uint ActiveProcesses, uint TotalProcesses, int[] MemberIds, bool QueryHandleClosed);

    private sealed class ProcessPin(SafeFileHandle handle, ProcessFact identity, string source, string imagePath, string imageIdentity, string sid, uint flags) : IDisposable
    {
        internal ProcessFact Identity { get; } = identity;
        internal bool Joined { get; private set; }
        internal bool Alive => Native.IsAlive(handle);
        internal SafeFileHandle Handle => handle;
        internal uint? ExitCode
        {
            get { if (Alive) return null; Native.Check(Native.GetExitCodeProcess(handle, out uint code), "GetExitCodeProcess(pin)"); return code; }
        }

        internal static ProcessPin OpenQualified(ProcessFact expected, string image, string expectedImageIdentity, string job)
        {
            var handle = Native.OpenObservation(expected.Pid);
            try { return Qualify(handle, expected, image, expectedImageIdentity, job, "qualified-post-open-query-pin"); }
            catch { handle.Dispose(); throw; }
        }

        internal static ProcessPin TakeTransferred(HandleProof proof, string image, string expectedImageIdentity, string job)
        {
            var handle = new SafeFileHandle(new IntPtr(long.Parse(proof.Handle, CultureInfo.InvariantCulture)), true);
            try
            {
                Require(proof.Source == "original-descendant-self-process-object", "transferred_original_self_source_required");
                return Qualify(handle, proof.Identity, image, expectedImageIdentity, job, proof.Source);
            }
            catch { handle.Dispose(); throw; }
        }

        internal static ProcessPin OpenSystemConsole(int candidatePid, string systemImage, string expectedImageIdentity, string job)
        {
            var handle = Native.OpenSystemConsoleObservation(candidatePid);
            try
            {
                var identity = Native.Identity(handle.DangerousGetHandle());
                Require(identity.Pid == candidatePid, "system_console_census_candidate_identity");
                return Qualify(handle, identity, systemImage, expectedImageIdentity, job,
                    "original-job-census-qualified-post-open-system-console-pin");
            }
            catch { handle.Dispose(); throw; }
        }

        private static ProcessPin Qualify(SafeFileHandle handle, ProcessFact expected, string image, string expectedImageIdentity, string job, string source)
        {
            Native.Check(!handle.IsInvalid, "process_pin_invalid");
            Require(Native.Identity(handle.DangerousGetHandle()) == expected, "original_process_identity_changed");
            Native.Check(Native.GetHandleInformation(handle, out uint flags), "GetHandleInformation(pin)");
            Require((flags & 1) == 0 && Native.IsAlive(handle), "qualified_pin_live_and_noninherited");
            string sid = Native.ProcessSid(handle);
            using var currentUser = WindowsIdentity.GetCurrent();
            Require(sid == currentUser.User?.Value, "qualified_pin_current_sid");
            string actualImage = Native.ImagePath(handle);
            Require(string.Equals(Path.GetFullPath(image), actualImage, StringComparison.OrdinalIgnoreCase), "qualified_pin_image_path");
            string actualImageIdentity = Native.FileIdentity(actualImage);
            Require(expectedImageIdentity == actualImageIdentity, "qualified_pin_frozen_image_file_identity");
            Native.RequireMemberAndCloseJob(job, handle);
            return new(handle, expected, source, actualImage, actualImageIdentity, sid, flags);
        }

        internal void Terminate()
        {
            Require(Alive, "retained_original_object_not_live_before_injection");
            Native.Check(Native.TerminateProcess(handle, 137), "TerminateProcess(original host only)");
        }

        internal Task JoinAsync(CancellationToken token) => Task.Run(() =>
        {
            using var wait = new BorrowedWait(handle);
            if (WaitHandle.WaitAny([wait, token.WaitHandle]) != 0) token.ThrowIfCancellationRequested();
            Require(!Alive, "native_original_process_join_required");
            Joined = true;
        });

        internal object Evidence() => new { Identity, source, independentCreationPin = false, imagePath, imageIdentity,
            sid, nonInherited = (flags & 1) == 0, inOriginalJobVerified = true, originalRetained = true, originalJoined = Joined, alive = Alive, exitCode = ExitCode };

        internal object SystemConsoleEvidence(string expectedImagePath, string expectedImageIdentity, string expectedSid) => new
        {
            identity = Identity, source, requestedAccess = 0x00101000, independentCreationPin = false,
            imagePath, imageIdentity, expectedImagePath, expectedImageIdentity, sid, sameSid = sid == expectedSid,
            nonInherited = (flags & 1) == 0, inOriginalJobVerified = true,
            qualifiedSystemConsole = source == "original-job-census-qualified-post-open-system-console-pin" && sid == expectedSid &&
                (flags & 1) == 0 && string.Equals(imagePath, expectedImagePath, StringComparison.OrdinalIgnoreCase) && imageIdentity == expectedImageIdentity,
            originalRetained = true, originalJoined = Joined, alive = Alive, signaled = !Alive, exitCode = ExitCode
        };
        public void Dispose() => handle.Dispose();
        private sealed class BorrowedWait : WaitHandle
        {
            internal BorrowedWait(SafeFileHandle source) => SafeWaitHandle = new SafeWaitHandle(source.DangerousGetHandle(), false);
        }
    }

    private static class Native
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        internal static void Check(bool success, string stage) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), stage); }
        internal static ProcessFact Identity(IntPtr process)
        {
            Check(GetProcessTimes(process, out long creation, out _, out _, out _), "GetProcessTimes(original object)");
            uint pid = GetProcessId(process);
            Check(pid != 0, "GetProcessId(original object)");
            Require(creation > 0, "original_creation_time_required");
            return new(checked((int)pid), unchecked((ulong)creation).ToString(CultureInfo.InvariantCulture));
        }

        internal static SafeFileHandle OpenObservation(int pid)
        {
            var handle = OpenProcess(0x00100000 | 0x1000 | 0x0001, false, pid);
            if (!handle.IsInvalid) return handle;
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "OpenProcess(qualified original observation)");
        }

        internal static SafeFileHandle OpenSystemConsoleObservation(int pid)
        {
            var handle = OpenProcess(0x00101000, false, pid);
            if (!handle.IsInvalid) return handle;
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "OpenProcess(original Job system-console query/synchronize)");
        }

        internal static SafeFileHandle OpenDuplicateTarget(ProcessFact expected)
        {
            var handle = OpenProcess(0x0040 | 0x1000, false, expected.Pid);
            try { Check(!handle.IsInvalid, "OpenProcess(duplicate target)"); Require(Identity(handle.DangerousGetHandle()) == expected, "duplicate_target_identity_changed"); return handle; }
            catch { handle.Dispose(); throw; }
        }

        internal static HandleProof DuplicateSelfTo(SafeFileHandle target)
        {
            var identity = Identity(new IntPtr(-1));
            Check(DuplicateHandle(new IntPtr(-1), new IntPtr(-1), target, out IntPtr transferred, 0, false, 2), "DuplicateHandle(original self to observer)");
            return new(identity, transferred.ToInt64().ToString(CultureInfo.InvariantCulture), "original-descendant-self-process-object");
        }

        internal static bool IsAlive(SafeFileHandle handle)
        {
            uint result = WaitForSingleObject(handle, 0);
            Check(result is 0 or 258, "WaitForSingleObject(original pin)");
            return result == 258;
        }

        internal static void RequireMemberAndCloseJob(string name, SafeFileHandle process)
        {
            using var job = OpenJobObjectW(4, false, name);
            Check(!job.IsInvalid, "OpenJobObjectW(short qualified query)");
            Check(IsProcessInJob(process, job, out bool member), "IsProcessInJob(original qualified pin)");
            Require(member, "qualified_pin_original_job_membership");
        }

        internal static JobCensus ObserveAndCloseJob(string name, IReadOnlyList<ProcessPin> pins)
        {
            uint active, total;
            int[] members;
            using (var job = OpenJobObjectW(4, false, name))
            {
                Check(!job.IsInvalid, "OpenJobObjectW(short census query)");
                Check(QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<BasicAccounting>(), IntPtr.Zero), "QueryInformationJobObject(original census)");
                active = accounting.ActiveProcesses;
                total = accounting.TotalProcesses;
                const int capacity = 16;
                int size = 8 + capacity * IntPtr.Size;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Check(QueryJobProcessIds(job, 3, buffer, (uint)size, out _), "QueryInformationJobObject(original members)");
                    uint assigned = unchecked((uint)Marshal.ReadInt32(buffer)), listed = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                    Require(assigned == listed && listed <= capacity, "exact_original_job_census_required");
                    members = Enumerable.Range(0, checked((int)listed)).Select(index => checked((int)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64())).ToArray();
                    foreach (var pin in pins)
                    {
                        Check(IsProcessInJob(pin.Handle, job, out bool member), "IsProcessInJob(census pin)");
                        Require(member && pin.Alive, "all_census_pins_still_live_original_members");
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            return new(active, total, members, true);
        }

        internal static string ProcessSid(SafeFileHandle process)
        {
            Check(OpenProcessToken(process, 8, out var token), "OpenProcessToken(pin)");
            using (token)
            {
                GetTokenInformation(token, 1, IntPtr.Zero, 0, out uint length);
                Require(length > 0, "process_token_user_size_required");
                IntPtr buffer = Marshal.AllocHGlobal(checked((int)length));
                try { Check(GetTokenInformation(token, 1, buffer, length, out _), "GetTokenInformation(pin user)"); return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value; }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }

        internal static string ImagePath(SafeFileHandle process)
        {
            var path = new StringBuilder(32768);
            uint length = (uint)path.Capacity;
            Check(QueryFullProcessImageNameW(process, 0, path, ref length), "QueryFullProcessImageNameW(pin)");
            return Path.GetFullPath(path.ToString());
        }

        internal static string FileIdentity(string path)
        {
            using var file = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            Check(GetFileInformationByHandle(file, out var info), "GetFileInformationByHandle(fixed image)");
            return info.VolumeSerialNumber.ToString("x8", CultureInfo.InvariantCulture) + ":" + info.FileIndexHigh.ToString("x8", CultureInfo.InvariantCulture) + info.FileIndexLow.ToString("x8", CultureInfo.InvariantCulture);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicAccounting
        {
            public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation
        {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, Links, FileIndexHigh, FileIndexLow;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeFileHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetHandleInformation(SafeFileHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, SafeFileHandle targetProcess, out IntPtr target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool member);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out BasicAccounting info, uint length, IntPtr returnedLength);
        [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryJobProcessIds(SafeFileHandle job, int informationClass, IntPtr info, uint length, out uint returnedLength);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(SafeFileHandle process, uint flags, StringBuilder path, ref uint length);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
        [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenProcessToken(SafeFileHandle process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetTokenInformation(SafeFileHandle token, int kind, IntPtr info, uint length, out uint returnedLength);
    }
}
