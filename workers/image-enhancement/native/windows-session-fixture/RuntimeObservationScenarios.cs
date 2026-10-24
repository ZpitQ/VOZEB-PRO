using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsSessionFixture;

internal static class RuntimeObservationScenarios
{
    private static bool Available(string executable)
    {
        var context = new AssemblyLoadContext("observation-capability", isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(Path.ChangeExtension(executable, ".dll"));
            var property = assembly.GetType("Zeb.WindowsSupervisor.SessionTestBridge")?.GetProperty(
                "RuntimeObservationAvailable", BindingFlags.Static | BindingFlags.NonPublic);
            if (property is null) return false;
            Program.Require(property.PropertyType == typeof(bool) && property.GetMethod is not null,
                "observation_capability_shape");
            return (bool)(property.GetValue(null) ?? throw new InvalidDataException("observation_capability_value"));
        }
        finally { context.Unload(); }
    }

    private static object Token(ProcessPin pin)
    {
        Probe.Check(OpenProcessToken(pin.Handle, 8, out var token), "observation_independent_token");
        using (token)
        {
            Probe.Check(GetTokenInformation(token, 12, out uint sessionId, 4, out uint returned) && returned == 4,
                "observation_independent_session");
            return new { pid = pin.Identity.Pid, creationFileTime = pin.Identity.CreationFileTime,
                userSid = Probe.ProcessSid(pin.Handle), sessionId };
        }
    }

    internal static async Task WriteEngineAsync(string command, NamedPipeClientStream pipe,
        ProcessFact identity, CancellationToken token)
    {
        bool stdout = command == "observation-stdout";
        byte[] bytes = command switch
        {
            "observation-half" => Program.Utf8.GetBytes("0."),
            "observation-tail" => Program.Utf8.GetBytes("00%\r\n"),
            "observation-repeat-held" or "observation-repeat-after" => Program.Utf8.GetBytes("1.25%\n100.00%\n0.00%\n"),
            "observation-stdout" => Program.Utf8.GetBytes("0.00%\n100.00%\n"),
            "observation-noise" => Program.Utf8.GetBytes(new string('x', checked((int)Probe.PipeCapacity(Probe.GetStdHandle(-12)) + 1)) +
                "0.00%\n-0.00%\n100.01%\n1%\n0.0%\n0.00% noise\n"),
            _ => throw new InvalidDataException("observation_fixed_engine_command"),
        };
        var stream = stdout ? Console.OpenStandardOutput() : Console.OpenStandardError();
        await stream.WriteAsync(bytes, token);
        await stream.FlushAsync(token);
        // Pipe flush acknowledges consumption of this fragment before the next command can write.
        using var handle = new SafeFileHandle(Probe.GetStdHandle(stdout ? -11 : -12), ownsHandle: false);
        Probe.Check(Probe.FlushFileBuffers(handle), "observation_actual_pipe_fragment_consumed");
        await Program.SendAsync(pipe, new { stage = command, role = "engine", identity,
            command, stream = stdout ? "stdout" : "stderr", bytes = bytes.Length, consumedBeforeAck = true }, token);
    }

    private static async Task<JsonElement> WriteAsync(EnginePeer peer, string command, CancellationToken token)
    {
        await peer.ReleaseAsync(command, token);
        var value = await peer.StageAsync(command, token);
        Program.Require(Program.Text(value, "command") == command && value.GetProperty("consumedBeforeAck").GetBoolean(),
            "observation_original_fragment_ack");
        return value;
    }

    private static JsonElement State(JsonElement response)
    {
        Program.Require(Program.Text(response, "kind") == "response", "observation_inspect_response");
        return response.GetProperty("state").Clone();
    }

    internal static async Task RunAsync(RunContext run, CancellationToken token)
    {
        var trace = new Dictionary<string, object?>();
        run.Values["runtimeObservation"] = trace;
        trace["available"] = Available(run.TestExe);
        if (trace["available"] is not true) return;

        string variant = run.Scenario["runtime-observation-".Length..];
        string fault = variant switch
        {
            "fragments" or "unmarked" or "noise" => "NvmlGraphicsOnly",
            "compute" => "NvmlComputeOnly",
            "multi" => "NvmlMultiDevice",
            "permission" => "NvmlPermission",
            "no-match" => "NvmlNoMatch",
            "incomplete" => "NvmlFillIncomplete",
            "engine-exit" or "deadline" => "NvmlBlockedReturn",
            _ => throw new InvalidDataException("observation_fixed_scenario"),
        };
        bool marked = variant != "unmarked", noSample = variant is "unmarked" or "noise";
        bool late = variant is "engine-exit" or "deadline";
        Program.Require(run.Spec.TryGetProperty("runtimeObservation", out var marker)
            ? marked && marker.ValueKind == JsonValueKind.String && marker.GetString() == "boot-v1" : !marked,
            "observation_original_marker_binding");
        trace["fault"] = fault;
        trace["marked"] = marked;
        var session = await run.SessionAsync(token, plan: new("observation", "BeforeNativeReturn", fault));
        var descriptor = await run.PrepareAsync(session, token);
        var engine = run.PinFact(descriptor.GetProperty("details").GetProperty("engine"));
        await run.RegisterAsync(engine, token);
        var actualToken = Token(engine);
        trace["originalEngine"] = actualToken;
        trace["descriptor"] = descriptor;
        var authorized = await run.ExchangeFrameAsync(session, run.BindOriginalAuthorize(session, descriptor), token);
        Program.Require(Program.Text(authorized, "kind") == "response" &&
            Program.Text(authorized.GetProperty("state"), "resumeState") == "succeeded", "observation_real_authorize");
        var peer = await run.PeerAsync("engine", descriptor, token);
        var writes = new List<object>();
        trace["writes"] = writes;
        writes.Add(await WriteAsync(peer, "observation-stdout", token));
        writes.Add(await WriteAsync(peer, "observation-noise", token));
        trace["beforeProgress"] = State(await run.ExchangeAsync(session, "inspect", token));
        if (variant != "noise")
        {
            writes.Add(await WriteAsync(peer, "observation-half", token));
            trace["afterHalf"] = State(await run.ExchangeAsync(session, "inspect", token));
            writes.Add(await WriteAsync(peer, "observation-tail", token));
        }
        var bridge = session.Bridge!;
        if (noSample)
        {
            await peer.ReleaseAsync("finish", token);
            // An incorrect unexpected sample is still released and genuinely joined,
            // so the later zero-sample assertion fails on behavior, not forced cleanup.
            using var stageWait = CancellationTokenSource.CreateLinkedTokenSource(token);
            var unexpected = bridge.ReachedAsync(stageWait.Token);
            var originalJoin = session.Subject.JoinAsync(token);
            if (await Task.WhenAny(originalJoin, unexpected) == unexpected)
            {
                trace["unexpectedNativeHeld"] = await unexpected;
                await bridge.ReleaseAsync(token);
            }
            await originalJoin;
            stageWait.Cancel();
            try { await unexpected; }
            catch (OperationCanceledException) when (stageWait.IsCancellationRequested && !token.IsCancellationRequested) { }
            await run.FinishNaturalAsync(session, token);
            trace["barrierReached"] = bridge.ObservationReached;
            if (bridge.ObservationReached)
            {
                trace["settled"] = await bridge.ObservationSettledAsync(token);
                trace["testPipeEof"] = await bridge.ObservationEofAsync(token);
            }
        }
        else
        {
            trace["nativeHeld"] = await bridge.ReachedAsync(token);
            trace["duringNative"] = State(await run.ExchangeAsync(session, "inspect", token));
            // More complete progress and real writes beyond each pipe's queried capacity must drain while native is held.
            writes.Add(await WriteAsync(peer, "observation-repeat-held", token));
            await peer.ReleaseAsync("capacity-write", token);
            trace["drainsDuringNative"] = await peer.StageAsync("capacity-complete", token);
            if (late)
            {
                if (variant == "deadline")
                    trace["sealedBeforeRelease"] = await run.EventAsync(session, "phase", "sealed", token);
                await peer.ReleaseAsync("finish", token);
                await peer.Pin.WaitAsync(token);
                await session.Observer.CallAsync("observation-result", new { key = "observer" }, token);
                trace["beforeRelease"] = State(await run.ExchangeAsync(session, "inspect", token, observer: true));
                var job = run.OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"));
                trace["heldAfterEngineExit"] = new
                {
                    engineJoined = peer.Pin.Joined, helperAlive = session.Subject.Pin.Alive,
                    activeProcesses = Probe.JobAccounting(job).ActiveProcesses,
                    terminalPresent = File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId)),
                    settledReceived = bridge.ObservationSettledReceived,
                };
            }
            await bridge.ReleaseAsync(token);
            if (!late)
            {
                var result = await session.Observer.CallAsync("observation-result", new { key = "observer" }, token);
                trace["afterResult"] = result.GetProperty("state").Clone();
                writes.Add(await WriteAsync(peer, "observation-repeat-after", token));
                await peer.ReleaseAsync("finish", token);
            }
            await run.FinishNaturalAsync(session, token);
            trace["settled"] = await bridge.ObservationSettledAsync(token);
            trace["testPipeEof"] = await bridge.ObservationEofAsync(token);
            trace["barrierReached"] = bridge.ObservationReached;
        }
        var observed = await session.Observer.CallAsync("wait-closed", new { key = "observer" }, token);
        Program.Require(observed.GetProperty("actualEof").GetBoolean() && !observed.GetProperty("localClose").GetBoolean() &&
            observed.GetProperty("readerError").ValueKind == JsonValueKind.Null, "observation_original_observer_eof");
        trace["states"] = observed.GetProperty("frames").EnumerateArray()
            .Where(frame => frame.TryGetProperty("state", out _)).Select(frame => frame.GetProperty("state").Clone()).ToArray();
        trace["helper"] = session.Subject.Pin.Evidence();
    }

    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeHandle process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeFileHandle token, int informationClass, out uint information, uint bytes, out uint returned);
}
