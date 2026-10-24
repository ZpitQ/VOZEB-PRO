using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsControlBridgeFixture;

internal static class Program
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly object LogGate = new();
    private static readonly ConditionalWeakTable<Stream, SemaphoreSlim> OutputWrites = new();
    private static FileStream? transcript;
    private static NamedPipeClientStream? testBarrier;
    private static object? barrierIdentity;
    private static int loggedBytes;
    private static long sendSequence;
    private static int transcriptLimit = 1048576;
    private static string? batchId;
    private static int eventsAttempted, eventsWritten, eventsCompleted, nativeStopCount;
    private static long eventBytesWritten;
    private static Task emitterTask = Task.CompletedTask;
    private static bool outputHelperFailure;
    private static int nativePipesLocallyClosing;
    private static string mode = "", executionId = "";
    private static bool sealedState;
    private static readonly TaskCompletionSource stop = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static readonly TaskCompletionSource<NamedPipeServerStream> observer = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static bool Hex(string value, int size) => value.Length == size && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool LocalRoot(string value) => value.Length >= 3 && char.IsAsciiLetter(value[0]) && value[1] == ':' && value[2] is '\\' or '/' && Path.IsPathFullyQualified(value) && !value.Contains('\0');
    private static void Require(bool condition) { if (!condition) throw new InvalidDataException("controlled_helper_contract"); }
    private static byte[] Frame(object value) => Utf8.GetBytes(JsonSerializer.Serialize(value, Json) + "\n");
    private static void Log(object value)
    {
        if (transcript is null) return;
        var bytes = Frame(value);
        lock (LogGate)
        {
            Require(loggedBytes + bytes.Length <= transcriptLimit);
            transcript.Write(bytes); transcript.Flush(true); loggedBytes += bytes.Length;
        }
    }
    private static async Task<byte[]?> ReadAsync(Stream input, CancellationToken token = default)
    {
        using var frame = new MemoryStream(); var one = new byte[1];
        while (await input.ReadAsync(one, token) != 0)
        {
            Require(frame.Length < 65536); frame.WriteByte(one[0]);
            if (one[0] == 10) return frame.ToArray();
        }
        Require(frame.Length == 0); return null;
    }
    private static JsonElement Parse(byte[] bytes)
    {
        Require(bytes.Length > 1 && bytes[^1] == 10 && !bytes.Contains((byte)13));
        using var document = JsonDocument.Parse(Utf8.GetString(bytes.AsSpan(0, bytes.Length - 1)));
        return document.RootElement.Clone();
    }
    private static async Task WriteAsync(Stream output, byte[] bytes, string channel, CancellationToken token = default, bool emitterEvent = false)
    {
        var writer = OutputWrites.GetValue(output, _ => new SemaphoreSlim(1));
        await writer.WaitAsync(token);
        long sequence = 0;
        var writeCompleted = false;
        try
        {
            sequence = Interlocked.Increment(ref sendSequence);
            Log(new { direction = "send-attempt", sequence, channel, bytesBase64 = Convert.ToBase64String(bytes) });
            if (emitterEvent) Interlocked.Increment(ref eventsAttempted);
            await output.WriteAsync(bytes, token);
            writeCompleted = true;
            if (emitterEvent) { Interlocked.Increment(ref eventsWritten); Interlocked.Add(ref eventBytesWritten, bytes.Length); }
            Log(new { direction = "send-write-completed", sequence, channel, bytes = bytes.Length });
            await output.FlushAsync(token);
            if (emitterEvent) Interlocked.Increment(ref eventsCompleted);
            Log(new { direction = "send-completed", sequence, channel, bytes = bytes.Length });
        }
        catch (Exception error)
        {
            Log(new { direction = "send-failed", sequence, channel, writeCompleted, flushCompleted = false, localCancellation = token.IsCancellationRequested, error = error.GetType().Name, nativeError = error is IOException ? (int?)(error.HResult & 0xffff) : null });
            throw;
        }
        finally { writer.Release(); }
    }
    private static object Snapshot() => new { phase = sealedState ? "sealed" : "claimed", sealReason = sealedState ? "stop" : (string?)null, requestFingerprint = (string?)null, descriptor = (object?)null, authorizationVerified = false, resumeState = "not-attempted", evidenceOutcome = "pending", completion = (string?)null };
    private static byte[] Response(JsonElement request, string role)
    {
        var response = JsonSerializer.SerializeToNode(new { v = 1, kind = "response", requestId = request.GetProperty("requestId").GetString(), op = request.GetProperty("op").GetString(), executionId, role, state = Snapshot() }, Json)!.AsObject();
        if (request.GetProperty("op").GetString() == "inspect")
        {
            switch (mode)
            {
                case "wrong-response-id": response["requestId"] = new string('f', 32); break;
                case "wrong-response-op": response["op"] = "claim"; break;
                case "wrong-response-execution": response["executionId"] = new string('f', 32); break;
                case "wrong-response-role": response["role"] = "observer"; break;
            }
        }
        var text = response.ToJsonString(Json);
        if (request.GetProperty("op").GetString() == "inspect" && mode == "response-overflow")
        {
            var original = text; text = "{" + new string(' ', 70000) + text[1..];
            using var before = JsonDocument.Parse(original); using var after = JsonDocument.Parse(text);
            Require(JsonElement.DeepEquals(before.RootElement, after.RootElement));
            Log(new { direction = "lifecycle", stage = "response-overflow-semantically-legal" });
        }
        if (request.GetProperty("op").GetString() == "inspect" && mode == "duplicate-response-key") text = text.Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal);
        return Utf8.GetBytes(text + (request.GetProperty("op").GetString() == "inspect" && mode == "native-response-crlf" ? "\r\n" : "\n"));
    }
    private static async Task ConnectionAsync(NamedPipeServerStream pipe, CancellationToken token)
    {
        var role = "observer";
        var reading = false;
        try
        {
            await pipe.WaitForConnectionAsync(token);
            while (true)
            {
                reading = true;
                var bytes = await ReadAsync(pipe, token);
                reading = false;
                if (bytes is null) break;
                Log(new { direction = "received", channel = "native-pipe", bytesBase64 = Convert.ToBase64String(bytes) });
                var request = Parse(bytes); var op = request.GetProperty("op").GetString();
                if (op == "claim") role = "owner";
                if (op == "watch") { role = "observer"; observer.TrySetResult(pipe); }
                if (op is not ("claim" or "watch" or "inspect" or "stop"))
                {
                    Log(new { direction = "forbidden-forward", op });
                    await WriteAsync(pipe, Frame(new { v = 1, kind = "error", requestId = request.GetProperty("requestId").GetString(), code = "forbidden" }), "native-pipe", token); continue;
                }
                if (op == "inspect" && mode == "hold-inspect") { Log(new { direction = "lifecycle", stage = "inspect-held" }); await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "fault-stage", stage = "inspect-held" }), "test-barrier", token); continue; }
                if (op == "stop") sealedState = true;
                if (op == "stop" && mode == "output-budget")
                {
                    Require(role == "owner" && Interlocked.Increment(ref nativeStopCount) == 1);
                    Log(new { direction = "lifecycle", stage = "native-stop-observed", requestId = request.GetProperty("requestId").GetString(), executionId });
                    await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "emitter-stage", stage = "native-stop-observed", batchId, requestId = request.GetProperty("requestId").GetString(), executionId, identity = barrierIdentity }), "test-barrier", token);
                    stop.TrySetResult(); return;
                }
                if (op == "stop" && mode is "held-live" or "one-sided-eof")
                {
                    Log(new { direction = "lifecycle", stage = "stop-held" });
                    if (mode == "one-sided-eof")
                    {
                        // Fault only after the host's accepted-close setup;
                        // a completed watch write cannot prove host binding.
                        var stderr = GetStdHandle(-12);
                        Require(GetHandleInformation(stderr, out _));
                        await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "fault-stage", stage = "stop-held", identity = barrierIdentity }), "test-barrier", token);
                        var release = Parse(await ReadAsync(testBarrier!, token) ?? throw new EndOfStreamException());
                        Require(release.ValueKind == JsonValueKind.Object && release.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).SequenceEqual(new[] { "kind", "v" }));
                        Require(release.GetProperty("v").GetInt32() == 1 && release.GetProperty("kind").GetString() == "release-stdout-eof");
                        Log(new { direction = "lifecycle", stage = "stdout-eof-released", identity = barrierIdentity });
                        Require(CloseHandle(GetStdHandle(-11)));
                        Require(GetHandleInformation(stderr, out _));
                        Log(new { direction = "lifecycle", stage = "actual-stdout-handle-closed", identity = barrierIdentity, stderrHandleKeptOpen = true });
                        await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "fault-stage", stage = "actual-stdout-closed", identity = barrierIdentity, stderrHandleKeptOpen = true }), "test-barrier", token);
                    }
                    continue;
                }
                var response = Response(request, role);
                if (op == "inspect") Log(new { direction = "inspect-response-selected", mode, originalRequestId = request.GetProperty("requestId").GetString(), bytesBase64 = Convert.ToBase64String(response) });
                await WriteAsync(pipe, response, "native-pipe", token);
                if (op == "inspect" && mode == "duplicate-response-frame")
                {
                    await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "fault-stage", stage = "first-legal-response-sent" }), "test-barrier", token);
                    var release = Parse(await ReadAsync(testBarrier!, token) ?? throw new EndOfStreamException());
                    Require(release.GetProperty("v").GetInt32() == 1 && release.GetProperty("kind").GetString() == "release-duplicate");
                    Log(new { direction = "lifecycle", stage = "duplicate-response-released-after-host-success" });
                    var duplicate = Response(request, role);
                    Log(new { direction = "duplicate-response-selected", originalRequestId = request.GetProperty("requestId").GetString(), bytesBase64 = Convert.ToBase64String(duplicate) });
                    await WriteAsync(pipe, duplicate, "native-pipe", token);
                }
                if (op == "watch" && mode != "output-budget")
                {
                    await WriteAsync(pipe, Frame(new { v = 1, kind = "event", @event = "state", executionId, state = Snapshot() }), "native-pipe", token);
                }
                if (op == "inspect" && mode == "event-flood")
                {
                    var watched = await observer.Task.WaitAsync(token);
                    for (var count = 0; count < 24; count++) await WriteAsync(watched, Frame(new { v = 1, kind = "event", @event = "state", executionId, state = Snapshot() }), "native-pipe", token);
                }
                if (op == "stop") { stop.TrySetResult(); return; }
            }
            Log(new { direction = "lifecycle", stage = "native-pipe-real-eof", role });
            if (role == "owner" && mode == "output-budget") await OwnerClosureAsync("zero-read", null, token);
            if (role == "owner" && mode is not ("held-live" or "one-sided-eof")) stop.TrySetResult();
        }
        catch (Exception error) when (token.IsCancellationRequested && error is OperationCanceledException or ObjectDisposedException or IOException) { }
        catch (IOException error) when (mode == "output-budget" && role == "owner" && reading && !token.IsCancellationRequested && Volatile.Read(ref nativePipesLocallyClosing) == 0 && (error.HResult & 0xffff) is 109 or 232 or 233)
        {
            try { await OwnerClosureAsync("remote-broken-pipe-read", error.HResult & 0xffff, token); }
            catch { outputHelperFailure = true; throw; }
            finally { stop.TrySetResult(); }
        }
        catch (IOException error) when (mode == "output-budget" && role == "observer" && reading && !token.IsCancellationRequested && Volatile.Read(ref nativePipesLocallyClosing) == 0 && (error.HResult & 0xffff) is 109 or 232 or 233)
        {
            try { Log(new { direction = "lifecycle", stage = "observer-remote-closure-read", nativeError = error.HResult & 0xffff, localCancellation = false }); }
            catch { outputHelperFailure = true; stop.TrySetResult(); throw; }
        }
        catch (Exception error) when (mode == "output-budget")
        {
            outputHelperFailure = true; stop.TrySetResult();
            Log(new { direction = "lifecycle", stage = "native-pipe-error", role, reading, localCancellation = token.IsCancellationRequested, error = error.GetType().Name });
        }
        catch (Exception error) { Log(new { direction = "lifecycle", stage = "native-pipe-error", error = error.GetType().Name }); if (mode is not ("held-live" or "one-sided-eof")) stop.TrySetResult(); }
    }
    private static async Task OwnerClosureAsync(string readOutcome, int? nativeError, CancellationToken token)
    {
        Require(!token.IsCancellationRequested && Volatile.Read(ref nativePipesLocallyClosing) == 0 && batchId is not null && Volatile.Read(ref eventsAttempted) > 0 && Volatile.Read(ref nativeStopCount) == 0);
        Log(new { direction = "lifecycle", stage = "autonomous-owner-closure", batchId, readOutcome, nativeError, localCancellation = false, originalPipeLocallyClosing = false, eventsAttempted = Volatile.Read(ref eventsAttempted) });
        await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "emitter-stage", stage = "autonomous-owner-closure", batchId, readOutcome, nativeError, localCancellation = false, originalPipeLocallyClosing = false, eventsAttempted = Volatile.Read(ref eventsAttempted), eventsWritten = Volatile.Read(ref eventsWritten), identity = barrierIdentity }), "test-barrier", token);
    }
    private static async Task EmitEventsAsync(NamedPipeServerStream watched, byte[] bytes, int count, CancellationToken token)
    {
        try
        {
            for (var index = 0; index < count; index++) await WriteAsync(watched, bytes, "native-pipe", token, emitterEvent: true);
            Log(new { direction = "lifecycle", stage = "batch-written", batchId, eventsAttempted, eventsWritten, eventsCompleted, bytesWritten = eventBytesWritten });
            await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "emitter-stage", stage = "batch-written", batchId, eventsAttempted, eventsWritten, eventsCompleted, bytesWritten = eventBytesWritten }), "test-barrier", token);
        }
        catch (Exception error) when ((token.IsCancellationRequested && error is OperationCanceledException or ObjectDisposedException or IOException) || (error is IOException io && (io.HResult & 0xffff) is 109 or 232 or 233))
        {
            // Receiver rejection can interrupt this exact native write. Its
            // settlement never supplies the separate owner's remote EOF.
            try { Log(new { direction = "lifecycle", stage = "emitter-interrupted", batchId, localCancellation = token.IsCancellationRequested, error = error.GetType().Name, eventsAttempted, eventsWritten, eventsCompleted, bytesWritten = eventBytesWritten }); }
            catch { outputHelperFailure = true; stop.TrySetResult(); throw; }
        }
        catch (Exception error)
        {
            outputHelperFailure = true; stop.TrySetResult();
            Log(new { direction = "lifecycle", stage = "emitter-error", error = error.GetType().Name });
        }
    }
    private static async Task EmitterCommandsAsync(CancellationToken token)
    {
        try
        {
            while (await ReadAsync(testBarrier!, token) is { } bytes)
            {
                Log(new { direction = "received", channel = "test-barrier", bytesBase64 = Convert.ToBase64String(bytes) });
                var command = Parse(bytes);
                Require(command.ValueKind == JsonValueKind.Object && command.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).SequenceEqual(new[] { "batchId", "count", "kind", "v" }));
                Require(command.GetProperty("v").GetInt32() == 1 && command.GetProperty("kind").GetString() == "emit-events" && batchId is null);
                var id = command.GetProperty("batchId").GetString()!; var count = command.GetProperty("count").GetInt32();
                Require(Hex(id, 32) && count == 64); batchId = id;
                var watched = await observer.Task.WaitAsync(token);
                var eventBytes = Frame(new { v = 1, kind = "event", @event = "state", executionId, state = Snapshot() });
                Require(eventBytes.Length <= 512);
                Log(new { direction = "lifecycle", stage = "batch-started", batchId, declaredEvents = count, nativeEventBytes = eventBytes.Length });
                await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "emitter-stage", stage = "batch-started", batchId, declaredEvents = count, nativeEventBytes = eventBytes.Length }), "test-barrier", token);
                emitterTask = EmitEventsAsync(watched, eventBytes, count, token);
            }
            if (!token.IsCancellationRequested) throw new EndOfStreamException();
        }
        catch (Exception error) when (token.IsCancellationRequested && error is OperationCanceledException or ObjectDisposedException or IOException) { }
        catch (Exception error)
        {
            outputHelperFailure = true; stop.TrySetResult();
            Log(new { direction = "lifecycle", stage = "emitter-control-error", error = error.GetType().Name });
        }
        finally
        {
            try { Log(new { direction = "lifecycle", stage = "emitter-control-settled", localCancellation = token.IsCancellationRequested }); }
            catch { outputHelperFailure = true; stop.TrySetResult(); throw; }
        }
    }
    private static async Task<int> OutputHelperAsync(string leaf)
    {
        using var first = new NamedPipeServerStream(leaf, PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var second = new NamedPipeServerStream(leaf, PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var shutdown = new CancellationTokenSource();
        var connections = new[] { ConnectionAsync(first, shutdown.Token), ConnectionAsync(second, shutdown.Token) };
        var control = EmitterCommandsAsync(shutdown.Token);
        try
        {
            await WriteAsync(Console.OpenStandardOutput(), Frame(new { v = 1, kind = "ready", executionId }), "helper-stdout");
            await stop.Task;
        }
        catch (Exception error)
        {
            outputHelperFailure = true; Log(new { direction = "lifecycle", stage = "output-helper-error", error = error.GetType().Name });
        }
        finally
        {
            // Close only these original native pipes before awaiting their
            // pending writes/readers. The independent barrier still drains.
            Interlocked.Exchange(ref nativePipesLocallyClosing, 1); shutdown.Cancel(); first.Dispose(); second.Dispose();
            // Joining the reader first fixes the emitter task's final owner;
            // its exception must not skip either emitter/connection joins.
            try { await control; }
            catch { outputHelperFailure = true; }
            finally
            {
                try { await Task.WhenAll(connections.Append(emitterTask)); }
                catch { outputHelperFailure = true; }
            }
        }
        Log(new { direction = "lifecycle", stage = "output-tasks-settled", batchId, eventsAttempted, eventsWritten, eventsCompleted, bytesWritten = eventBytesWritten, nativeStopCount, controlJoined = true, emitterJoined = true, connectionsJoined = true, outputHelperFailure });
        await WriteAsync(testBarrier!, Frame(new { v = 1, kind = "emitter-stage", stage = "output-tasks-settled", batchId, eventsAttempted, eventsWritten, eventsCompleted, bytesWritten = eventBytesWritten, nativeStopCount, controlJoined = true, emitterJoined = true, connectionsJoined = true, outputHelperFailure }), "test-barrier");
        Log(new { direction = "lifecycle", stage = "natural-exit", exitCode = outputHelperFailure ? 2 : 0 });
        return outputHelperFailure ? 2 : 0;
    }
    private static async Task BarrierAsync()
    {
        var leaf = Environment.GetEnvironmentVariable("ZEB_CONTROL_BRIDGE_FIXTURE_BARRIER") ?? throw new InvalidDataException();
        using var process = Process.GetCurrentProcess();
        Require(GetProcessTimes(process.SafeHandle, out var creation, out _, out _, out _));
        var identity = new { pid = Environment.ProcessId, creationFileTime = unchecked((ulong)creation).ToString(CultureInfo.InvariantCulture) };
        barrierIdentity = identity;
        var barrier = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous); testBarrier = barrier;
        await barrier.ConnectAsync();
        await WriteAsync(barrier, Frame(new { v = 1, kind = "helper-barrier", identity, mode }), "test-barrier");
        var release = Parse(await ReadAsync(barrier) ?? throw new EndOfStreamException());
        Require(release.GetProperty("v").GetInt32() == 1 && release.GetProperty("kind").GetString() == "continue");
        Log(new { direction = "lifecycle", stage = "helper-registered-before-fault", identity, identityEvidence = "test-self-query-not-creation-pin" });
        await WriteAsync(barrier, Frame(new { v = 1, kind = "barrier-released" }), "test-barrier");
    }
    private static async Task<int> HealthAsync()
    {
        var output = Console.OpenStandardOutput();
        await output.WriteAsync(Frame(new { v = 1, kind = "ready", executionId })); await output.FlushAsync();
        var input = Console.OpenStandardInput();
        if (mode == "sentinel")
        {
            var ping = Parse(await ReadAsync(input) ?? throw new EndOfStreamException()); Require(ping.GetProperty("kind").GetString() == "ping");
            await output.WriteAsync(Frame(new { v = 1, kind = "pong", requestId = ping.GetProperty("requestId").GetString() })); await output.FlushAsync();
        }
        return await input.ReadAsync(new byte[1]) == 0 ? 0 : 2;
    }
    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (OperatingSystem.IsWindows() && args.Length == 2 && args[0] == "--runtime-observation-protocol")
                return await RuntimeObservationProtocol.RunAsync(args[1]);
            if (!OperatingSystem.IsWindows() || args.Length != 10 || args[0] != "--pipe" || args[2] != "--controller-pid" || args[4] != "--records-root" || args[6] != "--installation-root" || args[8] != "--expected-manifest-sha256" ||
                !args[1].StartsWith("zeb-control-", StringComparison.Ordinal) || !Hex(args[1][12..], 32) || !uint.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out var controller) || controller == 0 || controller.ToString(CultureInfo.InvariantCulture) != args[3] || !LocalRoot(args[5]) || !LocalRoot(args[7]) || !Hex(args[9], 64)) return 2;
            mode = Environment.GetEnvironmentVariable("ZEB_CONTROL_BRIDGE_FIXTURE_MODE") ?? ""; executionId = Guid.NewGuid().ToString("N");
            if (mode is "guard-health" or "sentinel") return await HealthAsync();
            Require(mode is "controlled" or "no-ready" or "invalid-ready" or "malformed-ready" or "duplicate-ready-key" or "wrong-response-id" or "wrong-response-op" or "wrong-response-execution" or "wrong-response-role" or "duplicate-response-key" or "duplicate-response-frame" or "native-response-crlf" or "hold-inspect" or "stdout-extra" or "stdout-overflow" or "stderr-payload" or "response-overflow" or "event-flood" or "held-live" or "one-sided-eof" or "output-budget");
            if (mode == "output-budget")
            {
                Require(int.TryParse(Environment.GetEnvironmentVariable("ZEB_CONTROL_BRIDGE_FIXTURE_TRANSCRIPT_LIMIT"), NumberStyles.None, CultureInfo.InvariantCulture, out transcriptLimit) && transcriptLimit == 253952);
            }
            var path = Environment.GetEnvironmentVariable("ZEB_CONTROL_BRIDGE_FIXTURE_TRANSCRIPT") ?? throw new InvalidDataException(); Require(LocalRoot(path));
            using var log = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite, 4096, FileOptions.WriteThrough); transcript = log;
            Log(new { direction = "lifecycle", stage = "started", mode, actualBootstrapArguments = args, engineCreationCodeAbsent = true });
            await BarrierAsync(); if (mode == "no-ready") { Log(new { direction = "lifecycle", stage = "no-ready-natural-exit" }); return 0; }
            if (mode == "output-budget") return await OutputHelperAsync(args[1]);
            using var first = new NamedPipeServerStream(args[1], PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            using var second = new NamedPipeServerStream(args[1], PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            using var shutdown = new CancellationTokenSource();
            var connections = new[] { ConnectionAsync(first, shutdown.Token), ConnectionAsync(second, shutdown.Token) };
            var ready = Frame(new { v = 1, kind = "ready", executionId = mode == "invalid-ready" ? new string('Z', 32) : executionId });
            if (mode == "malformed-ready") ready = Utf8.GetBytes("{]\n");
            if (mode == "duplicate-ready-key") ready = Utf8.GetBytes(Utf8.GetString(ready).Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal));
            await WriteAsync(Console.OpenStandardOutput(), ready, "helper-stdout");
            if (mode == "stdout-extra") await WriteAsync(Console.OpenStandardOutput(), Utf8.GetBytes("{}\n"), "helper-stdout");
            if (mode == "stdout-overflow") await WriteAsync(Console.OpenStandardOutput(), Utf8.GetBytes(new string('x', 70000) + "\n"), "helper-stdout");
            if (mode == "stderr-payload") await WriteAsync(Console.OpenStandardError(), Utf8.GetBytes(new string('e', 9000)), "helper-stderr");
            await stop.Task; shutdown.Cancel(); first.Dispose(); second.Dispose(); await Task.WhenAll(connections);
            Log(new { direction = "lifecycle", stage = "natural-exit", exitCode = 0 }); return 0;
        }
        catch { return 2; }
        finally { testBarrier?.Dispose(); transcript = null; }
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
