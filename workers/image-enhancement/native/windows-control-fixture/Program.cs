using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsControlFixture;

internal static class Program
{
    internal static readonly UTF8Encoding Utf8 = new(false, true);
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    internal static string Self => Environment.ProcessPath ?? throw new InvalidOperationException("Fixture executable is unavailable.");

    private static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = Utf8;
        Console.OutputEncoding = Utf8;
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows fixture was requested on another OS.");
            return args.FirstOrDefault() switch
            {
                "harness" when args.Length == 5 => await Harness.RunAsync(args[1], args[2], Positive(args[3]), Positive(args[4])),
                "controller" when args.Length == 6 => await Agent.RunAsync(uint.Parse(args[1], CultureInfo.InvariantCulture), args[2], args[3], Positive(args[4]), args[5]),
                "observer" when args.Length == 2 => await Agent.RunAsync(null, null, null, Positive(args[1]), null),
                "private-target" when args.Length == 1 => await PrivateTargetAsync(),
                _ => throw new ArgumentException("Invalid private fixture bootstrap.")
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("fixture_failure/" + error.GetType().Name);
            return 1;
        }
    }

    private static int Positive(string value)
    {
        var parsed = int.Parse(value, CultureInfo.InvariantCulture);
        return parsed > 0 ? parsed : throw new ArgumentOutOfRangeException(nameof(value));
    }

    private static async Task<int> PrivateTargetAsync()
    {
        using var pin = ProcessPin.Open((uint)Environment.ProcessId);
        Write(new { kind = "fixture-positive", identity = pin.Identity, nonInherited = pin.NonInherited });
        Console.Error.WriteLine("fixture-positive-stderr");
        using var never = new ManualResetEvent(false);
        await Probe.WaitAsync(never, CancellationToken.None);
        return 0;
    }

    internal static void Write(object frame) => Console.WriteLine(JsonSerializer.Serialize(frame, Json));
    internal static JsonElement Element(object value) => JsonSerializer.SerializeToElement(value, Json);
    internal static string Text(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new InvalidDataException("Private fixture string is missing.");
    internal static object EncodingEvidence(Encoding encoding) => new { encoding.WebName, encoding.CodePage, encoderFallback = encoding.EncoderFallback.GetType().Name, decoderFallback = encoding.DecoderFallback.GetType().Name, preambleBytes = encoding.GetPreamble().Length };
    internal static string Leaf() => "zeb-control-" + Guid.NewGuid().ToString("N");
    internal static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidDataException(message);
    }
}

internal sealed record Identity(uint Pid, string CreatedFileTime);

internal sealed class ProcessPin : IDisposable
{
    internal SafeFileHandle Handle { get; }
    internal Identity Identity { get; }
    internal bool Alive => !Probe.Signaled(Handle);
    internal bool NonInherited => Probe.NonInherited(Handle);
    internal bool SameSid { get; }
    internal int? ExitCode
    {
        get
        {
            if (Alive) return null;
            Probe.Check(Probe.GetExitCodeProcess(Handle, out var code), "GetExitCodeProcess");
            return unchecked((int)code);
        }
    }

    private ProcessPin(SafeFileHandle handle)
    {
        Handle = handle;
        try
        {
            Identity = new Identity(Probe.GetProcessId(handle), Probe.CreationTime(handle).ToString(CultureInfo.InvariantCulture));
            SameSid = Probe.ProcessSid(handle) == Probe.CurrentSid;
            Program.Require(Identity.Pid > 0 && NonInherited, "Pinned process identity or noninherit query failed.");
        }
        catch { handle.Dispose(); throw; }
    }

    internal static ProcessPin Open(uint pid, uint extra = 0) => Adopt(Probe.OpenProcess(0x00101000 | extra, false, pid));
    internal static ProcessPin Adopt(SafeFileHandle handle, Identity? expected = null)
    {
        Probe.Check(!handle.IsInvalid, "OpenProcess/duplicate process");
        var pin = new ProcessPin(handle);
        if (expected is not null && pin.Identity != expected)
        {
            pin.Dispose();
            throw new InvalidDataException("Pinned PID/creation time differs from the trusted process object.");
        }
        return pin;
    }

    internal async Task WaitAsync(CancellationToken token)
    {
        using var wait = new ProcessWait(Handle);
        await Probe.WaitAsync(wait, token);
    }

    internal void Terminate()
    {
        if (Alive && !Probe.TerminateProcess(Handle, 1) && Alive) Probe.Check(false, "TerminateProcess(exact fixture cleanup)");
    }

    public void Dispose() => Handle.Dispose();
    private sealed class ProcessWait : WaitHandle
    {
        internal ProcessWait(SafeFileHandle handle) => SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), false);
    }
}

// This Job belongs only to the private harness. It supplies cleanup, not a
// production supervisor lifetime guarantee, and never enumerates other Jobs.
internal sealed class OwnershipGuard : IDisposable
{
    private readonly SafeFileHandle job;
    private readonly Dictionary<Identity, ProcessPin> observed = [];
    internal bool NonInherited => Probe.NonInherited(job);

    internal OwnershipGuard()
    {
        job = Probe.CreateJobObjectW(IntPtr.Zero, null);
        Probe.Check(!job.IsInvalid, "CreateJobObjectW(private fixture guard)");
        try
        {
            using var self = ProcessPin.Open((uint)Environment.ProcessId, 0x0100 | 0x0001);
            Probe.Check(Probe.AssignProcessToJobObject(job, self.Handle), "AssignProcessToJobObject(private fixture)");
            Program.Require(Probe.InJob(self.Handle, job) && NonInherited, "Private guard ownership or noninherit query failed.");
        }
        catch { job.Dispose(); throw; }
    }

    internal ProcessPin[] Capture(CancellationToken token)
    {
        var members = Probe.JobMembers(job, token);
        Program.Require(members.Contains((uint)Environment.ProcessId), "Harness lost its independently owned Job.");
        foreach (var pid in members.Where(pid => pid != (uint)Environment.ProcessId))
        {
            if (observed.Values.Any(pin => pin.Identity.Pid == pid)) continue;
            var pin = ProcessPin.Open(pid, 0x0001);
            if (!Probe.InJob(pin.Handle, job)) { pin.Dispose(); throw new InvalidDataException("Cleanup member is outside the private fixture Job."); }
            if (!observed.TryAdd(pin.Identity, pin)) pin.Dispose();
        }
        return observed.Values.ToArray();
    }

    internal async Task ReclaimAsync(CancellationToken token)
    {
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var live = Capture(token).Where(pin => pin.Alive).ToArray();
            if (live.Length == 0) return;
            var failures = new List<Exception>();
            foreach (var pin in live)
            {
                try { pin.Terminate(); }
                catch (Exception error) { failures.Add(error); }
            }
            try { await Task.WhenAll(live.Select(pin => pin.WaitAsync(token))); }
            catch (Exception error) { failures.Add(error); }
            if (failures.Count > 0) throw new AggregateException("Exact guard reclamation failed.", failures);
            // Requery follows real signaled process handles, never a delay/poll count.
        }
    }

    internal object Evidence(CancellationToken token)
    {
        var pins = Capture(token);
        var live = pins.Count(pin => pin.Alive);
        return new { membershipVerified = true, observedOwnedProcessCount = pins.Length, liveOwnedProcesses = live, allObservedJoined = pins.All(pin => !pin.Alive), nonInherited = NonInherited, processes = pins.Select(pin => new { pin.Identity, alive = pin.Alive }).ToArray() };
    }

    public void Dispose()
    {
        foreach (var pin in observed.Values) pin.Dispose();
        job.Dispose();
    }
}

internal sealed class StreamCapture
{
    private readonly List<string> lines = [];
    private readonly object gate = new();
    internal TaskCompletionSource<string?> First { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal Task Complete { get; }
    internal bool Eof { get; private set; }
    internal string? Error { get; private set; }
    internal string[] Lines { get { lock (gate) return lines.ToArray(); } }

    internal StreamCapture(StreamReader reader) => Complete = DrainAsync(reader);
    private async Task DrainAsync(StreamReader reader)
    {
        try
        {
            using (reader)
            {
                while (await reader.ReadLineAsync() is { } line)
                {
                    lock (gate) lines.Add(line);
                    First.TrySetResult(line);
                }
            }
            Eof = true;
        }
        catch (Exception error) { Error = error.GetType().Name + ": " + error.Message; }
        finally { First.TrySetResult(null); }
    }
}

internal sealed class TargetCapture : IDisposable
{
    private readonly bool privatePositive;
    internal ProcessPin Pin { get; }
    internal StreamCapture Stdout { get; }
    internal StreamCapture Stderr { get; }
    internal string? ReadyLine { get; private set; }
    internal JsonElement? Ready { get; private set; }
    internal string? ExecutionId => Ready is { ValueKind: JsonValueKind.Object } ready && ready.TryGetProperty("executionId", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : null;
    internal JsonElement Handoff { get; }

    internal TargetCapture(JsonElement handoff, bool privatePositive)
    {
        this.privatePositive = privatePositive;
        Handoff = handoff.Clone();
        var identity = handoff.GetProperty("identity").Deserialize<Identity>(Program.Json) ?? throw new InvalidDataException("No helper identity in private handoff.");
        Pin = ProcessPin.Adopt(new SafeFileHandle(Probe.Pointer(Program.Text(handoff, "processHandle")), true), identity);
        Stdout = new StreamCapture(new StreamReader(new FileStream(new SafeFileHandle(Probe.Pointer(Program.Text(handoff, "stdoutHandle")), true), FileAccess.Read), Program.Utf8));
        Stderr = new StreamCapture(new StreamReader(new FileStream(new SafeFileHandle(Probe.Pointer(Program.Text(handoff, "stderrHandle")), true), FileAccess.Read), Program.Utf8));
    }

    internal async Task<object> ObserveStartupAsync(CancellationToken token)
    {
        var exited = Pin.WaitAsync(token);
        await Task.WhenAny(Stdout.First.Task, exited).WaitAsync(token);
        if (!Pin.Alive) await Task.WhenAll(Stdout.Complete, Stderr.Complete).WaitAsync(token);
        ReadyLine = Stdout.First.Task.IsCompletedSuccessfully ? Stdout.First.Task.Result : null;
        if (ReadyLine is not null)
        {
            try { using var parsed = JsonDocument.Parse(ReadyLine); Ready = parsed.RootElement.Clone(); }
            catch (JsonException) { Ready = null; }
        }
        // EOF can precede the original process handle's signal. A real
        // non-ready subject must finish naturally before its startup receipt;
        // the deliberately resident private positive is a separate launch.
        if (!privatePositive && !HasReady)
        {
            await exited;
            await Task.WhenAll(Stdout.Complete, Stderr.Complete).WaitAsync(token);
        }
        return Snapshot();
    }

    internal bool HasReady => Ready is { ValueKind: JsonValueKind.Object } ready
        && ready.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).SequenceEqual(new[] { "executionId", "kind", "v" })
        && ready.GetProperty("v").ValueKind == JsonValueKind.Number && ready.GetProperty("v").TryGetInt32(out var v) && v == 1
        && ready.GetProperty("kind").ValueKind == JsonValueKind.String && ready.GetProperty("kind").GetString() == "ready"
        && ExecutionId is { Length: 32 } id && id.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal object Snapshot() => new { Pin.Identity, processHandleNonInherited = Pin.NonInherited, sameSid = Pin.SameSid, alive = Pin.Alive, exitCode = Pin.ExitCode, ReadyLine, Ready, stdout = Stdout.Lines, stderr = Stderr.Lines, stdoutEof = Stdout.Eof, stderrEof = Stderr.Eof, stdoutError = Stdout.Error, stderrError = Stderr.Error, handoff = Handoff };
    internal Task DrainAsync(CancellationToken token) => Task.WhenAll(Stdout.Complete, Stderr.Complete).WaitAsync(token);
    public void Dispose() => Pin.Dispose();
}

internal sealed class PipeClient : IDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly ProcessPin server;
    private readonly string expectedExecutionId;
    private readonly List<JsonElement> received = [];
    private readonly List<string> rawFrames = [];
    private readonly List<JsonElement> sentRequests = [];
    private readonly List<string> writtenBase64 = [];
    private readonly List<byte> pendingRequest = [];
    private readonly object gate = new();
    private readonly SemaphoreSlim changed = new(0);
    private readonly SemaphoreSlim writes = new(1);
    private readonly Task reader;
    private bool ended;
    private string? readError;
    internal object Evidence { get; }

    private PipeClient(NamedPipeClientStream pipe, ProcessPin server, string expectedExecutionId, object evidence)
    {
        this.pipe = pipe;
        this.server = server;
        this.expectedExecutionId = expectedExecutionId;
        Evidence = evidence;
        reader = ReadAsync();
    }

    internal static async Task<PipeClient> OpenAsync(string leaf, Identity expected, string expectedExecutionId, CancellationToken token)
    {
        var pipe = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
        ProcessPin? server = null;
        try
        {
            await pipe.ConnectAsync(token);
            Probe.Check(Probe.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid), "GetNamedPipeServerProcessId");
            server = ProcessPin.Open(pid);
            Program.Require(server.Identity == expected && server.SameSid && server.Alive, "Actual pipe server does not match the trusted helper PID/FILETIME/SID.");
            using var client = ProcessPin.Open((uint)Environment.ProcessId);
            var evidence = new { serverIdentity = server.Identity, serverMatchesTrustedHandle = server.Identity == expected, serverSameSid = server.SameSid, serverProcessHandleNonInherited = server.NonInherited, clientIdentity = client.Identity, clientProcessHandleNonInherited = client.NonInherited, pipeHandleNonInherited = Probe.NonInherited(pipe.SafePipeHandle), security = Probe.PipeSecurity(pipe.SafePipeHandle) };
            return new PipeClient(pipe, server, expectedExecutionId, evidence);
        }
        catch { pipe.Dispose(); server?.Dispose(); throw; }
    }

    private async Task ReadAsync()
    {
        try
        {
            using var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true);
            while (await ReadLfLineAsync(input) is { } line)
            {
                // Keep the original received text even if parsing or shape
                // validation subsequently rejects it.
                lock (gate)
                {
                    rawFrames.Add(line);
                    try
                    {
                        using var parsed = JsonDocument.Parse(line);
                        RejectDuplicateProperties(parsed.RootElement);
                        received.Add(parsed.RootElement.Clone());
                    }
                    catch (Exception error)
                    {
                        readError = error.GetType().Name + ": " + error.Message;
                        throw;
                    }
                }
                changed.Release();
            }
        }
        catch (Exception error)
        {
            if (error is DecoderFallbackException or JsonException or InvalidDataException || error is not (IOException or ObjectDisposedException)) readError = error.GetType().Name + ": " + error.Message;
        }
        finally { lock (gate) ended = true; changed.Release(); }
    }

    private static void RejectDuplicateProperties(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new InvalidDataException("Target response has duplicate JSON properties.");
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray()) RejectDuplicateProperties(item);
        }
    }

    private static async Task<string?> ReadLfLineAsync(StreamReader input)
    {
        var text = new StringBuilder();
        var character = new char[1];
        while (await input.ReadAsync(character.AsMemory()) != 0)
        {
            if (character[0] == '\n')
            {
                if (text.Length > 0 && text[^1] == '\r') text.Length--;
                return text.ToString();
            }
            text.Append(character[0]);
        }
        if (text.Length != 0) throw new InvalidDataException("Target emitted an EOF half-frame.");
        return null;
    }

    internal async Task WriteAsync(byte[] bytes, bool oneByte, CancellationToken token)
    {
        await writes.WaitAsync(token);
        var written = 0;
        try
        {
            if (oneByte)
            {
                foreach (var value in bytes)
                {
                    await pipe.WriteAsync(new byte[] { value }, token);
                    written++;
                }
            }
            else { await pipe.WriteAsync(bytes, token); written = bytes.Length; }
            await pipe.FlushAsync(token);
        }
        finally
        {
            try { lock (gate) RecordWrittenRequests(bytes.AsSpan(0, written)); }
            finally { writes.Release(); }
        }
    }

    private void RecordWrittenRequests(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0) return;
        writtenBase64.Add(Convert.ToBase64String(bytes));
        foreach (var value in bytes)
        {
            if (value != (byte)'\n') { pendingRequest.Add(value); continue; }
            try
            {
                using var parsed = JsonDocument.Parse(pendingRequest.ToArray());
                var request = parsed.RootElement;
                RejectDuplicateProperties(request);
                if (request.ValueKind == JsonValueKind.Object
                    && request.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).SequenceEqual(new[] { "executionId", "op", "requestId", "v" })
                    && request.GetProperty("v").ValueKind == JsonValueKind.Number && request.GetProperty("v").TryGetInt32(out var v) && v == 1
                    && request.GetProperty("requestId").ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(request.GetProperty("requestId").GetString())
                    && request.GetProperty("op").ValueKind == JsonValueKind.String && request.GetProperty("op").GetString() is "claim" or "inspect" or "watch" or "stop"
                    && request.GetProperty("executionId").ValueKind == JsonValueKind.String)
                    sentRequests.Add(request.Clone());
            }
            // Invalid raw requests remain in writtenBase64; they must reach
            // the real subject unchanged, without becoming trusted requests.
            catch (Exception error) when (error is JsonException or InvalidDataException) { }
            finally { pendingRequest.Clear(); }
        }
    }

    internal async Task<JsonElement> MatchAsync(Func<JsonElement, bool> predicate, CancellationToken token)
    {
        while (true)
        {
            lock (gate)
            {
                var found = received.FirstOrDefault(predicate);
                if (found.ValueKind != JsonValueKind.Undefined) return found.Clone();
                if (ended) throw new EndOfStreamException("Target closed before the required response/event. " + readError);
            }
            await changed.WaitAsync(token);
        }
    }

    internal async Task<JsonElement> ExchangeAsync(JsonElement request, CancellationToken token)
    {
        var id = Program.Text(request, "requestId");
        await WriteAsync(Program.Utf8.GetBytes(request.GetRawText() + "\n"), false, token);
        return await ResponseAsync(id, token);
    }

    internal async Task<JsonElement> ResponseAsync(string id, CancellationToken token)
    {
        var frame = await MatchAsync(frame => frame.ValueKind == JsonValueKind.Object && frame.TryGetProperty("requestId", out var request) && request.ValueKind == JsonValueKind.String && request.GetString() == id, token);
        if (frame.TryGetProperty("kind", out var kind) && kind.ValueKind == JsonValueKind.String && kind.GetString() == "response")
        {
            JsonElement request;
            lock (gate) request = sentRequests.LastOrDefault(sent => Program.Text(sent, "requestId") == id);
            Program.Require(request.ValueKind != JsonValueKind.Undefined, "Success response has no complete actual sent request.");
            Program.Require(Program.Text(frame, "op") == Program.Text(request, "op")
                && Program.Text(frame, "executionId") == Program.Text(request, "executionId")
                && Program.Text(frame, "executionId") == expectedExecutionId, "Success response differs from its actual request or trusted target execution.");
        }
        return frame;
    }
    internal async Task<JsonElement> EventAsync(string phase, CancellationToken token)
    {
        var frame = await MatchAsync(frame => frame.ValueKind == JsonValueKind.Object && frame.TryGetProperty("kind", out var kind) && kind.ValueKind == JsonValueKind.String && kind.GetString() == "event" && frame.GetProperty("state").GetProperty("phase").GetString() == phase, token);
        Program.Require(Program.Text(frame, "executionId") == expectedExecutionId, "Event differs from its connection's trusted target execution.");
        return frame;
    }
    internal async Task<object> ClosedAsync(CancellationToken token) { await reader.WaitAsync(token); return Snapshot(); }
    internal object Snapshot() { lock (gate) return new { serverIdentity = server.Identity, expectedExecutionId, sentRequests = sentRequests.Select(request => request.Clone()).ToArray(), writtenBase64 = writtenBase64.ToArray(), rawFrames = rawFrames.ToArray(), frames = received.Select(frame => frame.Clone()).ToArray(), readerEnded = ended, readerError = readError }; }
    internal async Task<object> CloseAsync(CancellationToken token) { pipe.Dispose(); return await ClosedAsync(token); }
    public void Dispose() { pipe.Dispose(); server.Dispose(); }
}

// Private child orchestration never exposes an operation on the production EXE.
internal static class Agent
{
    internal static async Task<int> RunAsync(uint? harnessPid, string? supervisor, string? directory, int executionMs, string? leaf)
    {
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        using var harness = harnessPid is { } pid ? ProcessPin.Open(pid, 0x0040) : null;
        var clients = new Dictionary<string, PipeClient>();
        var helpers = new List<Process>();
        Identity? helperIdentity = null;
        Program.Write(new { kind = "agent-ready", identity = self.Identity, nonInherited = self.NonInherited, sameSid = self.SameSid });
        try
        {
            while (await Console.In.ReadLineAsync() is { } line)
            {
                using var document = JsonDocument.Parse(line);
                var command = document.RootElement;
                var id = command.GetProperty("id").GetInt32();
                var op = Program.Text(command, "op");
                using var deadline = new CancellationTokenSource(executionMs);
                try
                {
                    object? value;
                    switch (op)
                    {
                        case "launch":
                        case "launch-positive":
                            Program.Require(harness is not null && supervisor is not null && directory is not null && leaf is not null, "Observer cannot launch a helper.");
                            var args = op == "launch-positive" ? new[] { "private-target" } : command.TryGetProperty("args", out var supplied) ? supplied.Deserialize<string[]>()! : new[] { "--pipe", leaf!, "--controller-pid", self.Identity.Pid.ToString(CultureInfo.InvariantCulture) };
                            var process = new Process { StartInfo = new ProcessStartInfo(op == "launch-positive" ? Program.Self : supervisor!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = directory! } };
                            foreach (var argument in args) process.StartInfo.ArgumentList.Add(argument);
                            Program.Require(process.Start(), "Private controller failed to load the fixed executable.");
                            helpers.Add(process);
                            using (var original = ProcessPin.Open((uint)process.Id))
                            {
                                helperIdentity = original.Identity;
                                var targetHandle = Probe.DuplicateTo(process.SafeHandle.DangerousGetHandle(), harness!.Handle);
                                var stdoutHandle = Probe.DuplicateTo(Probe.StreamHandle(process.StandardOutput.BaseStream), harness.Handle);
                                var stderrHandle = Probe.DuplicateTo(Probe.StreamHandle(process.StandardError.BaseStream), harness.Handle);
                                value = new { identity = helperIdentity, processHandle = targetHandle, stdoutHandle, stderrHandle, controllerIdentity = self.Identity, controllerRetainsHelperHandle = Probe.GetHandleInformation(process.SafeHandle, out var flags), originalHelperProcessHandleNonInherited = (flags & 1) == 0, controllerProcessHandleNonInherited = self.NonInherited };
                            }
                            process.StandardInput.Close();
                            process.StandardOutput.Dispose();
                            process.StandardError.Dispose();
                            break;
                        case "open":
                            var key = Program.Text(command, "key");
                            var expected = harness is not null ? helperIdentity ?? throw new InvalidOperationException("No helper was launched.") : command.GetProperty("expected").Deserialize<Identity>(Program.Json)!;
                            var targetLeaf = harness is not null ? leaf! : Program.Text(command, "leaf");
                            var client = await PipeClient.OpenAsync(targetLeaf, expected, Program.Text(command, "expectedExecutionId"), deadline.Token);
                            if (!clients.TryAdd(key, client)) { client.Dispose(); throw new InvalidOperationException("Duplicate private connection key."); }
                            value = client.Evidence;
                            break;
                        case "exchange":
                            value = await clients[Program.Text(command, "key")].ExchangeAsync(command.GetProperty("request"), deadline.Token);
                            break;
                        case "write":
                            var bytes = Convert.FromBase64String(Program.Text(command, "base64"));
                            await clients[Program.Text(command, "key")].WriteAsync(bytes, command.TryGetProperty("oneByte", out var chunks) && chunks.GetBoolean(), deadline.Token);
                            value = new { writtenBytes = bytes.Length };
                            break;
                        case "response":
                            value = await clients[Program.Text(command, "key")].ResponseAsync(Program.Text(command, "requestId"), deadline.Token);
                            break;
                        case "event":
                            value = await clients[Program.Text(command, "key")].EventAsync(Program.Text(command, "phase"), deadline.Token);
                            break;
                        case "snapshot":
                            value = clients[Program.Text(command, "key")].Snapshot();
                            break;
                        case "snapshot-all":
                            value = clients.ToDictionary(entry => entry.Key, entry => entry.Value.Snapshot());
                            break;
                        case "close":
                            value = await clients[Program.Text(command, "key")].CloseAsync(deadline.Token);
                            break;
                        case "wait-closed":
                            value = await clients[Program.Text(command, "key")].ClosedAsync(deadline.Token);
                            break;
                        case "race":
                            value = await Task.WhenAll(command.GetProperty("requests").EnumerateArray().Select(item => clients[Program.Text(item, "key")].ExchangeAsync(item.GetProperty("request"), deadline.Token)));
                            break;
                        case "inspect-private":
                            value = new { connectionKeys = clients.Keys.ToArray(), helperCount = helpers.Count, identity = self.Identity, alive = self.Alive };
                            break;
                        case "echo-private":
                            var text = Program.Text(command, "text");
                            value = new { text, utf8Base64 = Convert.ToBase64String(Program.Utf8.GetBytes(text)), consoleEncodings = new { stdin = Program.EncodingEvidence(Console.InputEncoding), stdout = Program.EncodingEvidence(Console.OutputEncoding), stderr = Program.EncodingEvidence(Console.Error.Encoding) } };
                            break;
                        case "exit":
                            Program.Write(new { id, ok = true, value = new { identity = self.Identity, code = 0 }, pipes = clients.ToDictionary(entry => entry.Key, entry => entry.Value.Snapshot()) });
                            return 0;
                        default:
                            throw new InvalidDataException("Unknown private fixture operation.");
                    }
                    Program.Write(new { id, ok = true, value, pipes = clients.ToDictionary(entry => entry.Key, entry => entry.Value.Snapshot()) });
                }
                catch (Exception error) { Program.Write(new { id, ok = false, error = new { type = error.GetType().Name, message = error.Message, stage = op }, pipes = clients.ToDictionary(entry => entry.Key, entry => entry.Value.Snapshot()) }); }
            }
            return 0;
        }
        finally
        {
            foreach (var client in clients.Values) client.Dispose();
            foreach (var helper in helpers) helper.Dispose();
        }
    }
}

internal sealed class RpcClient : IDisposable
{
    private readonly Process process;
    internal ProcessPin Pin { get; }
    private readonly Dictionary<int, TaskCompletionSource<JsonElement>> pending = [];
    private readonly object gate = new();
    private readonly SemaphoreSlim writes = new(1);
    private readonly Task reader;
    private readonly TaskCompletionSource<JsonElement> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<string> stdout = [];
    private JsonElement pipes = Program.Element(new Dictionary<string, object>());
    private readonly StreamCapture stderr;
    private int sequence;
    private string? readerError;

    internal RpcClient(string directory, params string[] arguments)
    {
        process = new Process { StartInfo = new ProcessStartInfo(Program.Self) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = Program.Utf8, StandardOutputEncoding = Program.Utf8, StandardErrorEncoding = Program.Utf8, WorkingDirectory = directory } };
        foreach (var argument in arguments) process.StartInfo.ArgumentList.Add(argument);
        Program.Require(process.Start(), "Could not launch the private fixture child.");
        Pin = ProcessPin.Open((uint)process.Id);
        stderr = new StreamCapture(process.StandardError);
        reader = ReadAsync();
    }

    internal Task<JsonElement> ReadyAsync(CancellationToken token) => ready.Task.WaitAsync(token);
    internal object StreamEncodings => new { stdin = Program.EncodingEvidence(process.StandardInput.Encoding), stdout = Program.EncodingEvidence(process.StandardOutput.CurrentEncoding), stderr = Program.EncodingEvidence(process.StandardError.CurrentEncoding) };
    private async Task ReadAsync()
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                lock (gate) stdout.Add(line);
                using var parsed = JsonDocument.Parse(line);
                var frame = parsed.RootElement.Clone();
                if (frame.TryGetProperty("kind", out var kind) && kind.GetString() == "agent-ready") { ready.TrySetResult(frame); continue; }
                if (frame.TryGetProperty("pipes", out var snapshots)) { lock (gate) pipes = snapshots.Clone(); }
                var id = frame.GetProperty("id").GetInt32();
                TaskCompletionSource<JsonElement>? completion;
                lock (gate) { pending.Remove(id, out completion); }
                completion?.TrySetResult(frame);
            }
        }
        catch (Exception error) { readerError = error.GetType().Name + ": " + error.Message; }
        finally
        {
            var failure = new EndOfStreamException("Private child output ended before a response. " + readerError);
            ready.TrySetException(failure);
            lock (gate) { foreach (var completion in pending.Values) completion.TrySetException(failure); pending.Clear(); }
        }
    }

    internal async Task<JsonElement> CallAsync(string op, object? payload, CancellationToken token)
    {
        var id = Interlocked.Increment(ref sequence);
        var fields = payload is null ? new Dictionary<string, JsonElement>() : Program.Element(payload).EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone());
        fields.Add("id", Program.Element(id));
        fields.Add("op", Program.Element(op));
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate) pending.Add(id, completion);
        await writes.WaitAsync(token);
        try { await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(fields, Program.Json).AsMemory(), token); await process.StandardInput.FlushAsync(token); }
        finally { writes.Release(); }
        var reply = await completion.Task.WaitAsync(token);
        if (!reply.GetProperty("ok").GetBoolean()) throw new InvalidDataException("Private child operation failed: " + reply.GetRawText());
        return reply.GetProperty("value").Clone();
    }

    internal async Task DrainAsync(CancellationToken token)
    {
        await Pin.WaitAsync(token);
        await Task.WhenAll(reader, stderr.Complete).WaitAsync(token);
    }

    internal object Snapshot()
    {
        lock (gate) return new { Pin.Identity, alive = Pin.Alive, exitCode = Pin.ExitCode, nonInherited = Pin.NonInherited, stdout = stdout.ToArray(), stderr = stderr.Lines, stdoutEof = reader.IsCompleted && readerError is null, stderrEof = stderr.Eof, stdoutError = readerError, stderrError = stderr.Error, pipes = pipes.Clone() };
    }
    public void Dispose() { Pin.Dispose(); process.Dispose(); }
}

internal sealed record Session(RpcClient Controller, RpcClient Observer, TargetCapture Target, string Leaf, string ExecutionId);

internal sealed class RunContext(string scenario, string supervisor, string directory, int executionMs, OwnershipGuard guard)
{
    internal Dictionary<string, object?> Values { get; } = [];
    internal List<RpcClient> Agents { get; } = [];
    internal List<TargetCapture> Targets { get; } = [];
    private int requestSequence;

    internal JsonElement Request(string op, string executionId, string? requestId = null) => Program.Element(new { v = 1, requestId = requestId ?? scenario + "-" + Interlocked.Increment(ref requestSequence).ToString(CultureInfo.InvariantCulture), op, executionId });
    internal async Task<RpcClient> ControllerAsync(string leaf, CancellationToken token)
    {
        var child = new RpcClient(directory, "controller", Environment.ProcessId.ToString(CultureInfo.InvariantCulture), supervisor, directory, executionMs.ToString(CultureInfo.InvariantCulture), leaf);
        Agents.Add(child);
        Values["controller-" + Agents.Count] = await child.ReadyAsync(token);
        guard.Capture(token);
        return child;
    }
    internal async Task<RpcClient> ObserverAsync(CancellationToken token)
    {
        var child = new RpcClient(directory, "observer", executionMs.ToString(CultureInfo.InvariantCulture));
        Agents.Add(child);
        Values["observer-" + Agents.Count] = await child.ReadyAsync(token);
        guard.Capture(token);
        return child;
    }
    internal async Task<TargetCapture> LaunchAsync(RpcClient controller, object? payload, CancellationToken token, bool positive = false)
    {
        var handoff = await controller.CallAsync(positive ? "launch-positive" : "launch", payload, token);
        var target = new TargetCapture(handoff, privatePositive: positive);
        Targets.Add(target);
        guard.Capture(token);
        return target;
    }
    internal async Task<Session> SessionAsync(CancellationToken token, string? prefix = null)
    {
        var leaf = Program.Leaf();
        var controller = await ControllerAsync(leaf, token);
        var target = await LaunchAsync(controller, null, token);
        var startup = await target.ObserveStartupAsync(token);
        Values[(prefix ?? "subject") + "Startup"] = startup;
        Program.Require(target.HasReady, "Loaded subject did not supply the frozen ready/control contract.");
        var observer = await ObserverAsync(token);
        Values[(prefix ?? "subject") + "Pipe"] = await OpenAsync(observer, "watcher", leaf, target.Pin.Identity, token);
        return new Session(controller, observer, target, leaf, target.ExecutionId!);
    }
    internal Task<JsonElement> OpenAsync(RpcClient agent, string key, string leaf, Identity identity, CancellationToken token)
    {
        var target = Targets.Single(target => target.Pin.Identity == identity);
        Program.Require(target.HasReady, "Pipe connection has no pinned target with a valid ready execution.");
        return agent.CallAsync("open", new { key, leaf, expected = identity, expectedExecutionId = target.ExecutionId! }, token);
    }
    internal Task<JsonElement> ExchangeAsync(RpcClient agent, string key, string op, string executionId, CancellationToken token, string? requestId = null) => agent.CallAsync("exchange", new { key, request = Request(op, executionId, requestId) }, token);
    internal Task<JsonElement> WatchAsync(Session session, CancellationToken token) => ExchangeAsync(session.Observer, "watcher", "watch", session.ExecutionId, token);
    internal async Task<JsonElement> ClaimAsync(Session session, CancellationToken token, string key = "owner")
    {
        Values[key + "Pipe-" + Targets.Count] = await OpenAsync(session.Controller, key, session.Leaf, session.Target.Pin.Identity, token);
        return await ExchangeAsync(session.Controller, key, "claim", session.ExecutionId, token);
    }
    internal Task<JsonElement> EventAsync(RpcClient agent, string key, string phase, CancellationToken token) => agent.CallAsync("event", new { key, phase }, token);
    internal Task<JsonElement> SnapshotAsync(RpcClient agent, string key, CancellationToken token) => agent.CallAsync("snapshot", new { key }, token);
    internal async Task<JsonElement> BarrierAsync(Session session, CancellationToken token, string label)
    {
        var response = await ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        Values[label + "Barrier"] = response;
        return await SnapshotAsync(session.Observer, "watcher", token);
    }
    internal Task<JsonElement> WriteAsync(RpcClient agent, string key, byte[] bytes, CancellationToken token, bool oneByte = false) => agent.CallAsync("write", new { key, base64 = Convert.ToBase64String(bytes), oneByte }, token);
    internal async Task CapturePipesAsync(CancellationToken token)
    {
        // An intentional controller exit already transferred its last pipe
        // snapshots in that RPC's envelope. Collect every remaining client,
        // including closed/invalid ones, before any cleanup termination.
        foreach (var agent in Agents.Where(agent => agent.Pin.Alive))
            await agent.CallAsync("snapshot-all", null, token);
    }
    internal object Receipt(object? failure, object cleanup) => new { scenario, values = Values, targets = Targets.Select(target => target.Snapshot()).ToArray(), agents = Agents.Select(agent => agent.Snapshot()).ToArray(), failure, cleanup };
}

internal static class Harness
{
    internal static async Task<int> RunAsync(string supervisor, string directory, int executionMs, int cleanupMs)
    {
        if (!File.Exists(supervisor) || !Path.IsPathFullyQualified(supervisor) || !Directory.Exists(directory)) throw new ArgumentException("Fixed executable/working directory does not exist.");
        using var guard = new OwnershipGuard();
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        Program.Write(new { kind = "harness-ready", identity = self.Identity, selfProcessHandleNonInherited = self.NonInherited, guardHandleNonInherited = guard.NonInherited, sameSid = self.SameSid, productionAssemblyReferenced = AppDomain.CurrentDomain.GetAssemblies().Any(assembly => assembly.GetName().Name == "WindowsSupervisor") });
        while (await Console.In.ReadLineAsync() is { } line)
        {
            using var parsed = JsonDocument.Parse(line);
            var command = parsed.RootElement;
            var id = command.GetProperty("id").GetInt32();
            var scenario = Program.Text(command, "scenario");
            var context = new RunContext(scenario, supervisor, directory, executionMs, guard);
            object? failure = null;
            var cleanupFailures = new List<object>();
            object cleanup;
            try
            {
                using var deadline = new CancellationTokenSource(executionMs);
                await ScenarioAsync(context, scenario, deadline.Token);
                await context.CapturePipesAsync(deadline.Token);
            }
            catch (Exception error) { failure = new { type = error.GetType().Name, message = error.Message, stage = scenario }; }
            finally
            {
                using var grace = new CancellationTokenSource(cleanupMs);
                try { await guard.ReclaimAsync(grace.Token); }
                catch (Exception error) { cleanupFailures.Add(new { stage = "guard-reclaim", type = error.GetType().Name, message = error.Message }); }
                foreach (var target in context.Targets)
                {
                    try { await target.Pin.WaitAsync(grace.Token); await target.DrainAsync(grace.Token); }
                    catch (Exception error) { cleanupFailures.Add(new { stage = "helper-join-and-streams", type = error.GetType().Name, message = error.Message }); }
                }
                foreach (var agent in context.Agents)
                {
                    try { await agent.DrainAsync(grace.Token); }
                    catch (Exception error) { cleanupFailures.Add(new { stage = "private-agent-join-and-streams", type = error.GetType().Name, message = error.Message }); }
                }
                object? ownership = null;
                try { ownership = guard.Evidence(grace.Token); }
                catch (Exception error) { cleanupFailures.Add(new { stage = "guard-final-query", type = error.GetType().Name, message = error.Message }); }
                cleanup = new { ownership, failures = cleanupFailures.ToArray() };
            }
            Program.Write(new { id, ok = failure is null && cleanupFailures.Count == 0, value = context.Receipt(failure, cleanup) });
            foreach (var target in context.Targets) target.Dispose();
            foreach (var agent in context.Agents) agent.Dispose();
        }
        using (var grace = new CancellationTokenSource(cleanupMs))
        {
            await guard.ReclaimAsync(grace.Token);
            Program.Require(Program.Element(guard.Evidence(grace.Token)).GetProperty("liveOwnedProcesses").GetInt32() == 0, "Harness EOF left a live fixture member.");
        }
        return 0;
    }

    private static Task ScenarioAsync(RunContext run, string scenario, CancellationToken token) => scenario switch
    {
        "positive" => PositiveAsync(run, token),
        "C1" => C1Async(run, token),
        "C2" => C2Async(run, token),
        "C3" => C3Async(run, token),
        "C4" => C4Async(run, token),
        "C5" => C5Async(run, token),
        "C6" => C6Async(run, token),
        "C7" => C7Async(run, token),
        "C8" => C8Async(run, token),
        "C9" => C9Async(run, token),
        "C10" => C10Async(run, token),
        "C11" => C11Async(run, token),
        "C11-first" => C11FirstAsync(run, token),
        "C12" => C12Async(run, token),
        _ => throw new InvalidDataException("Unknown frozen Windows scenario.")
    };

    private static async Task PositiveAsync(RunContext run, CancellationToken token)
    {
        var boundaries = new List<string>();
        run.Values["loopbackBoundaries"] = boundaries;
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        var leaf = Program.Leaf();
        using var server = Probe.LocalServer(leaf);
        boundaries.Add("CreateNamedPipe-returned");
        Probe.Check(Probe.GetNamedPipeInfo(server.SafePipeHandle, out var flags, out var outputBufferBytes, out var inputBufferBytes, out var maximumInstances), "GetNamedPipeInfo(private positive diagnostic)");
        run.Values["loopbackPipeInfo"] = new { flags, outputBufferBytes, inputBufferBytes, maximumInstances };
        var accepted = server.WaitForConnectionAsync(token);
        boundaries.Add("WaitForConnectionAsync-dispatched");
        using var client = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
        run.Values["loopbackPendingOperation"] = "client-ConnectAsync";
        await client.ConnectAsync(token);
        boundaries.Add("client-ConnectAsync-completed");
        run.Values["loopbackPendingOperation"] = "server-WaitForConnectionAsync";
        await accepted;
        boundaries.Add("server-WaitForConnectionAsync-completed");
        Probe.Check(Probe.GetNamedPipeClientProcessId(server.SafePipeHandle, out var clientPid), "GetNamedPipeClientProcessId(private positive)");
        Probe.Check(Probe.GetNamedPipeServerProcessId(client.SafePipeHandle, out var serverPid), "GetNamedPipeServerProcessId(private positive)");
        using var actualClient = ProcessPin.Open(clientPid);
        using var actualServer = ProcessPin.Open(serverPid);
        boundaries.Add("actual-client-and-server-identities-opened");
        var bytes = Program.Utf8.GetBytes("private-loopback-中文\n");
        using var input = new StreamReader(server, Program.Utf8, false, leaveOpen: true);
        var reading = input.ReadLineAsync(token).AsTask();
        boundaries.Add("server-ReadLineAsync-dispatched");
        run.Values["loopbackPendingOperation"] = "client-WriteAsync+server-ReadLineAsync";
        var writing = client.WriteAsync(bytes, token).AsTask();
        await Task.WhenAll(writing, reading);
        boundaries.Add("client-WriteAsync-completed");
        boundaries.Add("server-ReadLineAsync-completed");
        var line = await reading;
        run.Values["loopbackPendingOperation"] = null;
        run.Values["loopback"] = new { serverIdentity = actualServer.Identity, clientIdentity = actualClient.Identity, trustedIdentity = self.Identity, sameSid = actualServer.SameSid && actualClient.SameSid, serverHandleNonInherited = Probe.NonInherited(server.SafePipeHandle), clientHandleNonInherited = Probe.NonInherited(client.SafePipeHandle), security = Probe.PipeSecurity(server.SafePipeHandle), received = line };
        var controller = await run.ControllerAsync(Program.Leaf(), token);
        var target = await run.LaunchAsync(controller, null, token, positive: true);
        run.Values["positiveTargetStartup"] = await target.ObserveStartupAsync(token);
        run.Values["positiveTargetStderr"] = await target.Stderr.First.Task.WaitAsync(token);
        run.Values["positiveController"] = await controller.CallAsync("inspect-private", null, token);
        var rpcText = "private-rpc-中文\"引号\nline\r\t\\";
        run.Values["positiveRpcExpected"] = rpcText;
        run.Values["positiveRpc"] = await controller.CallAsync("echo-private", new { text = rpcText }, token);
        run.Values["positiveRpcEncodings"] = new { expected = Program.EncodingEvidence(Program.Utf8), parent = controller.StreamEncodings };
        run.Values["positiveTargetAliveBeforeCleanup"] = target.Pin.Alive;
    }

    private static async Task C1Async(RunContext run, CancellationToken token)
    {
        var leaf = Program.Leaf();
        var controller = await run.ControllerAsync(leaf, token);
        var target = await run.LaunchAsync(controller, null, token);
        run.Values["subjectStartup"] = await target.ObserveStartupAsync(token);
        // A loaded, nonzero scaffold is an observation for the C1 assertion,
        // never a fixture setup exception or a fabricated ready value.
        if (!target.HasReady) return;
        var observer = await run.ObserverAsync(token);
        run.Values["subjectPipe"] = await run.OpenAsync(observer, "client", leaf, target.Pin.Identity, token);
        run.Values["inspect"] = await run.ExchangeAsync(observer, "client", "inspect", target.ExecutionId!, token);
        run.Values["helperAliveAfterInspect"] = target.Pin.Alive;
        run.Values["controllerAliveAfterInspect"] = controller.Pin.Alive;
    }

    private static async Task C2Async(RunContext run, CancellationToken token)
    {
        var leaf = Program.Leaf();
        var controller = await run.ControllerAsync(leaf, token);
        var pid = controller.Pin.Identity.Pid.ToString(CultureInfo.InvariantCulture);
        var invalid = new List<(string Label, string[] Args)>
        {
            ("missing-both", []), ("missing-pipe-value", ["--pipe"]),
            ("missing-controller", ["--pipe", leaf]),
            ("duplicate-pipe", ["--pipe", leaf, "--pipe", leaf, "--controller-pid", pid]),
            ("duplicate-controller", ["--pipe", leaf, "--controller-pid", pid, "--controller-pid", pid]),
            ("unknown-option", ["--pipe", leaf, "--controller-pid", pid, "--unknown", "value"])
        };
        foreach (var value in new[] { "0", "-1", "4294967296", "not-a-pid" }) invalid.Add(("invalid-pid-" + value, ["--pipe", leaf, "--controller-pid", value]));
        foreach (var value in new[] { "zeb-control-ABCDEF0123456789abcdef0123456789", "zeb-control-1234", "other-" + Guid.NewGuid().ToString("N"), @"\\.\pipe\" + leaf, @"\\remote\pipe\" + leaf, leaf + "/child", leaf + "\\child" }) invalid.Add(("invalid-leaf-" + invalid.Count, ["--pipe", value, "--controller-pid", pid]));
        var receipts = new List<object>();
        foreach (var entry in invalid)
        {
            var target = await run.LaunchAsync(controller, new { args = entry.Args }, token);
            receipts.Add(new { entry.Label, startup = await target.ObserveStartupAsync(token) });
        }
        var exitedController = await run.ObserverAsync(token);
        await exitedController.CallAsync("exit", null, token);
        await exitedController.Pin.WaitAsync(token);
        // Isolate this negative bootstrap's possible side effects, while its
        // original no-ready assertion still rejects an accepted dead object.
        var deadControllerTarget = await run.LaunchAsync(controller, new { args = new[] { "--pipe", Program.Leaf(), "--controller-pid", exitedController.Pin.Identity.Pid.ToString(CultureInfo.InvariantCulture) } }, token);
        receipts.Add(new { label = "signaled-controller-object", controllerSignaled = !exitedController.Pin.Alive, startup = await deadControllerTarget.ObserveStartupAsync(token) });
        run.Values["invalidBootstrap"] = receipts;
        using var occupied = Probe.LocalServer(leaf);
        run.Values["occupiedSecurity"] = Probe.PipeSecurity(occupied.SafePipeHandle);
        var collision = await run.LaunchAsync(controller, new { args = new[] { "--pipe", leaf, "--controller-pid", pid } }, token);
        run.Values["collisionStartup"] = await collision.ObserveStartupAsync(token);
        var accept = occupied.WaitForConnectionAsync(token);
        using var connection = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous);
        await connection.ConnectAsync(token);
        await accept;
        Probe.Check(Probe.GetNamedPipeServerProcessId(connection.SafePipeHandle, out var actualPid), "GetNamedPipeServerProcessId(occupied pipe)");
        using var actual = ProcessPin.Open(actualPid);
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        var marker = Program.Utf8.GetBytes("occupied-original-owner\n");
        using var input = new StreamReader(occupied, Program.Utf8, false, leaveOpen: true);
        var reading = input.ReadLineAsync(token).AsTask();
        var writing = connection.WriteAsync(marker, token).AsTask();
        await Task.WhenAll(writing, reading);
        run.Values["occupiedAfterCollision"] = new { serverIdentity = actual.Identity, trustedIdentity = self.Identity, received = await reading, handleNonInherited = Probe.NonInherited(occupied.SafePipeHandle) };
    }

    private static async Task C3Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        run.Values["observerInspect"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        run.Values["observerWatch"] = await run.WatchAsync(session, token);
        run.Values["observerClaim"] = await run.ExchangeAsync(session.Observer, "watcher", "claim", session.ExecutionId, token);
        await run.OpenAsync(session.Observer, "forged", session.Leaf, session.Target.Pin.Identity, token);
        var forged = "{\"v\":1,\"requestId\":\"forged-client-pid\",\"op\":\"claim\",\"executionId\":\"" + session.ExecutionId + "\",\"clientPID\":" + session.Controller.Pin.Identity.Pid + "}\n";
        await run.WriteAsync(session.Observer, "forged", Program.Utf8.GetBytes(forged), token);
        run.Values["forgedClosed"] = await session.Observer.CallAsync("wait-closed", new { key = "forged" }, token);
        run.Values["afterForged"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        run.Values["ownerClaim"] = await run.ClaimAsync(session, token);
        run.Values["claimedEvent"] = await run.EventAsync(session.Observer, "watcher", "claimed", token);
        run.Values["observerStop"] = await run.ExchangeAsync(session.Observer, "watcher", "stop", session.ExecutionId, token);
        run.Values["sealedEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
        run.Values["finalWatchFrames"] = await run.BarrierAsync(session, token, "final");
    }

    private static async Task C4Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        run.Values["watch"] = await run.WatchAsync(session, token);
        run.Values["ownerA"] = await run.OpenAsync(session.Controller, "a", session.Leaf, session.Target.Pin.Identity, token);
        run.Values["ownerB"] = await run.OpenAsync(session.Controller, "b", session.Leaf, session.Target.Pin.Identity, token);
        var responses = await session.Controller.CallAsync("race", new { requests = new[] { new { key = "a", request = run.Request("claim", session.ExecutionId, "claim-a") }, new { key = "b", request = run.Request("claim", session.ExecutionId, "claim-b") } } }, token);
        run.Values["claims"] = responses;
        var winner = responses[0].GetProperty("kind").GetString() == "response" ? "a" : "b";
        run.Values["winnerRepeat"] = await run.ExchangeAsync(session.Controller, winner, "claim", session.ExecutionId, token);
        run.Values["winnerInspect"] = await run.ExchangeAsync(session.Controller, winner, "inspect", session.ExecutionId, token);
        run.Values["watchFrames"] = await run.BarrierAsync(session, token, "repeated");
        run.Values["controllerIdentity"] = session.Controller.Pin.Identity;
    }

    private static async Task C5Async(RunContext run, CancellationToken token)
    {
        var first = await run.SessionAsync(token, "ordered");
        run.Values["initialWatch"] = await run.WatchAsync(first, token);
        run.Values["repeatInitialWatch"] = await run.WatchAsync(first, token);
        run.Values["orderedClaim"] = await run.ClaimAsync(first, token);
        run.Values["orderedClaimedEvent"] = await run.EventAsync(first.Observer, "watcher", "claimed", token);
        run.Values["repeatClaim"] = await run.ExchangeAsync(first.Controller, "owner", "claim", first.ExecutionId, token);
        run.Values["orderedFrames"] = await run.BarrierAsync(first, token, "ordered");
        run.Values["orderedStop"] = await run.ExchangeAsync(first.Observer, "watcher", "stop", first.ExecutionId, token);
        await run.EventAsync(first.Observer, "watcher", "sealed", token);
        await run.OpenAsync(first.Observer, "late", first.Leaf, first.Target.Pin.Identity, token);
        run.Values["lateWatch"] = await run.ExchangeAsync(first.Observer, "late", "watch", first.ExecutionId, token);
        run.Values["lateInspect"] = await run.ExchangeAsync(first.Observer, "late", "inspect", first.ExecutionId, token);
        run.Values["lateFrames"] = await run.SnapshotAsync(first.Observer, "late", token);
        var concurrent = await run.SessionAsync(token, "concurrent");
        await run.OpenAsync(concurrent.Controller, "owner", concurrent.Leaf, concurrent.Target.Pin.Identity, token);
        var watch = run.WatchAsync(concurrent, token);
        var claim = run.ExchangeAsync(concurrent.Controller, "owner", "claim", concurrent.ExecutionId, token);
        await Task.WhenAll(watch, claim);
        run.Values["concurrentWatch"] = await watch;
        run.Values["concurrentClaim"] = await claim;
        if ((await watch).GetProperty("state").GetProperty("phase").GetString() == "unclaimed") run.Values["concurrentEvent"] = await run.EventAsync(concurrent.Observer, "watcher", "claimed", token);
        run.Values["concurrentFrames"] = await run.BarrierAsync(concurrent, token, "concurrent");
    }

    private static async Task C6Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        run.Values["watch"] = await run.WatchAsync(session, token);
        run.Values["claim"] = await run.ClaimAsync(session, token);
        await run.EventAsync(session.Observer, "watcher", "claimed", token);
        run.Values["ownerClosed"] = await session.Controller.CallAsync("close", new { key = "owner" }, token);
        run.Values["sealedEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
        run.Values["controllerAliveAtSeal"] = session.Controller.Pin.Alive;
        run.Values["helperAliveAtSeal"] = session.Target.Pin.Alive;
        run.Values["reclaim"] = await run.ClaimAsync(session, token, "replacement");
        run.Values["finalFrames"] = await run.BarrierAsync(session, token, "final");
    }

    private static async Task C7Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        run.Values["watch"] = await run.WatchAsync(session, token);
        run.Values["controllerBeforeExit"] = await session.Controller.CallAsync("inspect-private", null, token);
        run.Values["controllerExitAck"] = await session.Controller.CallAsync("exit", null, token);
        await session.Controller.Pin.WaitAsync(token);
        run.Values["controllerExitCode"] = session.Controller.Pin.ExitCode;
        run.Values["controllerSignaled"] = !session.Controller.Pin.Alive;
        run.Values["sealedEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
        run.Values["helperAliveAtSeal"] = session.Target.Pin.Alive;
        run.Values["observerAliveAtSeal"] = session.Observer.Pin.Alive;
        await run.OpenAsync(session.Observer, "late", session.Leaf, session.Target.Pin.Identity, token);
        run.Values["lateClaim"] = await run.ExchangeAsync(session.Observer, "late", "claim", session.ExecutionId, token);
        run.Values["finalFrames"] = await run.BarrierAsync(session, token, "final");
    }

    private static async Task C8Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        run.Values["watch"] = await run.WatchAsync(session, token);
        run.Values["claim"] = await run.ClaimAsync(session, token);
        await run.EventAsync(session.Observer, "watcher", "claimed", token);
        run.Values["controllerExitAck"] = await session.Controller.CallAsync("exit", null, token);
        await session.Controller.Pin.WaitAsync(token);
        run.Values["controllerSignaled"] = !session.Controller.Pin.Alive;
        run.Values["sealedEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
        run.Values["helperAliveAtSeal"] = session.Target.Pin.Alive;
        run.Values["observerAliveAtSeal"] = session.Observer.Pin.Alive;
        run.Values["afterExitInspect"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        run.Values["afterExitStop"] = await run.ExchangeAsync(session.Observer, "watcher", "stop", session.ExecutionId, token);
        run.Values["finalFrames"] = await run.BarrierAsync(session, token, "final");
    }

    private static async Task C9Async(RunContext run, CancellationToken token)
    {
        foreach (var claimed in new[] { false, true })
        {
            var name = claimed ? "claimed" : "unclaimed";
            var session = await run.SessionAsync(token, name);
            var values = new Dictionary<string, object?>();
            values["watch"] = await run.WatchAsync(session, token);
            if (claimed)
            {
                values["claim"] = await run.ClaimAsync(session, token);
                await run.EventAsync(session.Observer, "watcher", "claimed", token);
            }
            values["wrongScopeStop"] = await run.ExchangeAsync(session.Observer, "watcher", "stop", Guid.NewGuid().ToString("N"), token);
            values["afterWrongScope"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
            if (claimed) values["ownerAfterWrongScope"] = await run.ExchangeAsync(session.Controller, "owner", "claim", session.ExecutionId, token);
            values["stop"] = await run.ExchangeAsync(session.Observer, "watcher", "stop", session.ExecutionId, token);
            values["sealedEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
            values["helperAliveAfterStop"] = session.Target.Pin.Alive;
            values["repeatStop"] = await run.ExchangeAsync(session.Observer, "watcher", "stop", session.ExecutionId, token);
            values["lateClaim"] = claimed ? await run.ExchangeAsync(session.Controller, "owner", "claim", session.ExecutionId, token) : await run.ClaimAsync(session, token);
            values["frames"] = await run.BarrierAsync(session, token, name + "Final");
            run.Values[name] = values;
        }
    }

    private static async Task C10Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        var unicode = "中文\"引号\nline\r\t\\&|<>^%$(echo)";
        var unicodeRequest = run.Request("inspect", session.ExecutionId, unicode);
        run.Values["unicodeWritten"] = await run.WriteAsync(session.Observer, "watcher", Program.Utf8.GetBytes(unicodeRequest.GetRawText() + "\r\n"), token, oneByte: true);
        run.Values["unicodeResponse"] = await session.Observer.CallAsync("response", new { key = "watcher", requestId = unicode }, token);
        run.Values["unicodeExpected"] = unicode;
        var one = run.Request("inspect", session.ExecutionId, "merged-one");
        var two = run.Request("inspect", session.ExecutionId, "merged-two");
        run.Values["mergedWritten"] = await run.WriteAsync(session.Observer, "watcher", Program.Utf8.GetBytes(one.GetRawText() + "\n" + two.GetRawText() + "\r\n"), token);
        run.Values["mergedOne"] = await session.Observer.CallAsync("response", new { key = "watcher", requestId = "merged-one" }, token);
        run.Values["mergedTwo"] = await session.Observer.CallAsync("response", new { key = "watcher", requestId = "merged-two" }, token);
        run.Values["partialPipe"] = await run.OpenAsync(session.Observer, "partial", session.Leaf, session.Target.Pin.Identity, token);
        var partial = run.Request("inspect", session.ExecutionId, "partial-no-newline");
        run.Values["partialWritten"] = await run.WriteAsync(session.Observer, "partial", Program.Utf8.GetBytes(partial.GetRawText() + "\r"), token);
        run.Values["independentBarrier"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        run.Values["partialBeforeNewline"] = await run.SnapshotAsync(session.Observer, "partial", token);
        await run.WriteAsync(session.Observer, "partial", new byte[] { 10 }, token);
        run.Values["partialResponse"] = await session.Observer.CallAsync("response", new { key = "partial", requestId = "partial-no-newline" }, token);
        run.Values["frames"] = await run.SnapshotAsync(session.Observer, "watcher", token);
        run.Values["helperAliveAfterLiteralData"] = session.Target.Pin.Alive;
    }

    private static async Task C11Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        run.Values["watch"] = await run.WatchAsync(session, token);
        run.Values["claim"] = await run.ClaimAsync(session, token);
        await run.EventAsync(session.Observer, "watcher", "claimed", token);
        var valid = run.Request("inspect", session.ExecutionId, "bad-observer").GetRawText();
        var malformed = new List<(string Label, byte[] Bytes)>
        {
            ("invalid-utf8", new byte[] { 0xc3, 0x28, 10 }),
            ("duplicate-property", Program.Utf8.GetBytes(valid.Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal) + "\n")),
            ("unknown-property", Program.Utf8.GetBytes(valid[..^1] + ",\"private-invalid-body-sentinel\":true}\n")),
            ("unknown-op", Program.Utf8.GetBytes(valid.Replace("\"inspect\"", "\"authorize\"", StringComparison.Ordinal) + "\n")),
            ("wrong-version-type", Program.Utf8.GetBytes(valid.Replace("\"v\":1", "\"v\":\"1\"", StringComparison.Ordinal) + "\n")),
            ("wrong-id-type", Program.Utf8.GetBytes(valid.Replace("\"bad-observer\"", "17", StringComparison.Ordinal) + "\n")),
            ("non-object", Program.Utf8.GetBytes("[]\n")),
            ("invalid-json", Program.Utf8.GetBytes("{not-json}\n")),
            ("missing-field", Program.Utf8.GetBytes("{\"v\":1,\"requestId\":\"missing-field\",\"op\":\"inspect\"}\n"))
        };
        var receipts = new List<object>();
        foreach (var entry in malformed)
        {
            var key = entry.Label;
            var pipe = await run.OpenAsync(session.Observer, key, session.Leaf, session.Target.Pin.Identity, token);
            var written = await run.WriteAsync(session.Observer, key, entry.Bytes, token);
            var closed = await session.Observer.CallAsync("wait-closed", new { key }, token);
            var ownerInspect = await run.ExchangeAsync(session.Controller, "owner", "inspect", session.ExecutionId, token);
            receipts.Add(new { entry.Label, pipe, written, closed, ownerInspect });
        }
        run.Values["invalidObservers"] = receipts;
        await run.OpenAsync(session.Observer, "eof-half", session.Leaf, session.Target.Pin.Identity, token);
        await run.WriteAsync(session.Observer, "eof-half", Program.Utf8.GetBytes("{\"v\":1"), token);
        run.Values["halfBeforeClose"] = await run.SnapshotAsync(session.Observer, "eof-half", token);
        run.Values["halfClosed"] = await session.Observer.CallAsync("close", new { key = "eof-half" }, token);
        run.Values["ownerAfterHalfEof"] = await run.ExchangeAsync(session.Controller, "owner", "inspect", session.ExecutionId, token);
        run.Values["ownerBeforeViolation"] = await run.SnapshotAsync(session.Controller, "owner", token);
        var ownerInvalid = run.Request("inspect", session.ExecutionId, "bad-owner").GetRawText().Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal) + "\n";
        await run.WriteAsync(session.Controller, "owner", Program.Utf8.GetBytes(ownerInvalid), token);
        run.Values["invalidOwnerClosed"] = await session.Controller.CallAsync("wait-closed", new { key = "owner" }, token);
        run.Values["sealedEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
        run.Values["finalFrames"] = await run.BarrierAsync(session, token, "final");
    }

    private static async Task C11FirstAsync(RunContext run, CancellationToken token)
    {
        // SessionAsync opens exactly this observer before any other client.
        // Its completed inspect is the causal barrier for the first peer.
        var session = await run.SessionAsync(token, "first");
        run.Values["firstInspect"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        run.Values["firstBeforeInvalid"] = await run.SnapshotAsync(session.Observer, "watcher", token);
        var malformed = run.Request("inspect", session.ExecutionId, "first-invalid").GetRawText().Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal) + "\n";
        run.Values["firstInvalidWritten"] = await run.WriteAsync(session.Observer, "watcher", Program.Utf8.GetBytes(malformed), token);
        run.Values["firstAfterInvalidBeforeEof"] = await run.SnapshotAsync(session.Observer, "watcher", token);
        run.Values["helperAliveBeforeEof"] = session.Target.Pin.Alive;
        run.Values["controllerAliveBeforeEof"] = session.Controller.Pin.Alive;
        // This operation only waits on the reader; it does not close the
        // client pipe and cannot manufacture the server's actual EOF.
        run.Values["firstPendingOperation"] = "wait-closed(first-observer)";
        run.Values["firstClosed"] = await session.Observer.CallAsync("wait-closed", new { key = "watcher" }, token);
        run.Values["firstPendingOperation"] = null;
        run.Values["freshPipe"] = await run.OpenAsync(session.Observer, "fresh", session.Leaf, session.Target.Pin.Identity, token);
        run.Values["freshInspect"] = await run.ExchangeAsync(session.Observer, "fresh", "inspect", session.ExecutionId, token);
        run.Values["helperAliveAfterFreshInspect"] = session.Target.Pin.Alive;
        run.Values["controllerAliveAfterFreshInspect"] = session.Controller.Pin.Alive;
    }

    private static async Task C12Async(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token, "scope");
        run.Values["watch"] = await run.WatchAsync(session, token);
        await run.OpenAsync(session.Observer, "wrong", session.Leaf, session.Target.Pin.Identity, token);
        var wrong = Guid.NewGuid().ToString("N");
        var errors = new List<JsonElement>();
        foreach (var op in new[] { "inspect", "watch", "claim", "stop" }) errors.Add(await run.ExchangeAsync(session.Observer, "wrong", op, wrong, token));
        run.Values["wrongScopeResponses"] = errors;
        run.Values["afterWrongScopes"] = await run.ExchangeAsync(session.Observer, "watcher", "inspect", session.ExecutionId, token);
        run.Values["scopeClaim"] = await run.ClaimAsync(session, token);
        await run.EventAsync(session.Observer, "watcher", "claimed", token);
        run.Values["wrongScopeBarrier"] = await run.ExchangeAsync(session.Observer, "wrong", "inspect", session.ExecutionId, token);
        run.Values["wrongScopeFrames"] = await run.SnapshotAsync(session.Observer, "wrong", token);
        run.Values["stop"] = await run.ExchangeAsync(session.Observer, "watcher", "stop", session.ExecutionId, token);
        run.Values["stopEvent"] = await run.EventAsync(session.Observer, "watcher", "sealed", token);
        run.Values["lateOriginalClaim"] = await run.ExchangeAsync(session.Controller, "owner", "claim", session.ExecutionId, token);
        run.Values["lateReplacementClaim"] = await run.ClaimAsync(session, token, "replacement");
        run.Values["lateObserverClaim"] = await run.ExchangeAsync(session.Observer, "watcher", "claim", session.ExecutionId, token);
        run.Values["stopFrames"] = await run.BarrierAsync(session, token, "stopFinal");
        var eof = await run.SessionAsync(token, "eof");
        await run.WatchAsync(eof, token);
        run.Values["eofClaim"] = await run.ClaimAsync(eof, token);
        await run.EventAsync(eof.Observer, "watcher", "claimed", token);
        await eof.Controller.CallAsync("close", new { key = "owner" }, token);
        run.Values["eofEvent"] = await run.EventAsync(eof.Observer, "watcher", "sealed", token);
        run.Values["lateEofClaim"] = await run.ClaimAsync(eof, token, "replacement");
        run.Values["eofFrames"] = await run.BarrierAsync(eof, token, "eofFinal");
        var race = await run.SessionAsync(token, "race");
        await run.WatchAsync(race, token);
        await run.OpenAsync(race.Controller, "owner", race.Leaf, race.Target.Pin.Identity, token);
        var claim = run.ExchangeAsync(race.Controller, "owner", "claim", race.ExecutionId, token);
        var stop = run.ExchangeAsync(race.Observer, "watcher", "stop", race.ExecutionId, token);
        await Task.WhenAll(claim, stop);
        run.Values["raceClaim"] = await claim;
        run.Values["raceStop"] = await stop;
        run.Values["raceEvent"] = await run.EventAsync(race.Observer, "watcher", "sealed", token);
        run.Values["raceLateClaim"] = await run.ExchangeAsync(race.Controller, "owner", "claim", race.ExecutionId, token);
        run.Values["raceFrames"] = await run.BarrierAsync(race, token, "raceFinal");
    }
}

// Standalone Win32 probes; no production project, assembly or verification helper.
internal static class Probe
{
    internal static string CurrentSid { get; } = ReadCurrentSid();
    private static string ReadCurrentSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User?.Value ?? throw new InvalidOperationException("Current token has no user SID.");
    }
    internal static IntPtr Pointer(string value) => new(long.Parse(value, CultureInfo.InvariantCulture));
    internal static void Check(bool result, string stage)
    {
        if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), stage + " failed in independent fixture.");
    }
    internal static bool NonInherited(SafeHandle handle)
    {
        Check(GetHandleInformation(handle, out var flags), "GetHandleInformation");
        return (flags & 1) == 0;
    }
    internal static bool Signaled(SafeHandle handle)
    {
        var value = WaitForSingleObject(handle, 0);
        if (value == 0) return true;
        if (value == 258) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
    }
    internal static ulong CreationTime(SafeFileHandle handle)
    {
        Check(GetProcessTimes(handle, out var creation, out _, out _, out _), "GetProcessTimes");
        return unchecked((ulong)creation);
    }
    internal static string ProcessSid(SafeFileHandle handle)
    {
        Check(OpenProcessToken(handle, 8, out var token), "OpenProcessToken");
        using (token)
        {
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out var bytes);
            if (bytes == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(size) failed.");
            var memory = Marshal.AllocHGlobal(checked((int)bytes));
            try
            {
                Check(GetTokenInformation(token, 1, memory, bytes, out _), "GetTokenInformation(user)");
                return new SecurityIdentifier(Marshal.ReadIntPtr(memory)).Value;
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
    }
    internal static IntPtr StreamHandle(Stream stream) => stream switch
    {
        FileStream file => file.SafeFileHandle.DangerousGetHandle(),
        PipeStream pipe => pipe.SafePipeHandle.DangerousGetHandle(),
        _ => throw new InvalidDataException("Fixed runtime redirected stream has no supported kernel handle.")
    };
    internal static string DuplicateTo(IntPtr source, SafeFileHandle target)
    {
        Check(DuplicateHandle(GetCurrentProcess(), source, target, out var duplicate, 0, false, 2), "DuplicateHandle(private harness handoff)");
        return duplicate.ToInt64().ToString(CultureInfo.InvariantCulture);
    }
    internal static bool InJob(SafeFileHandle process, SafeFileHandle job)
    {
        Check(IsProcessInJob(process, job, out var member), "IsProcessInJob(private fixture guard)");
        return member;
    }
    internal static uint[] JobMembers(SafeFileHandle job, CancellationToken token)
    {
        Check(QueryInformationJobObject(job, 1, out Accounting accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero), "QueryInformationJobObject(accounting)");
        var capacity = accounting.ActiveProcesses;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var bytes = checked(8 + (int)capacity * IntPtr.Size);
            var buffer = Marshal.AllocHGlobal(bytes);
            try
            {
                Marshal.WriteInt32(buffer, 0, 0);
                Marshal.WriteInt32(buffer, 4, 0);
                if (!QueryInformationJobObject(job, 3, buffer, (uint)bytes, out var returned))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 234) throw new Win32Exception(error, "Private Job member query failed.");
                    var assigned = checked((uint)Marshal.ReadInt32(buffer));
                    var required = returned > 8 ? (returned - 8) / (uint)IntPtr.Size : 0;
                    var larger = Math.Max(assigned, required);
                    Program.Require(larger > capacity, "Job query did not provide a larger real buffer size.");
                    capacity = larger;
                    continue;
                }
                var count = checked((uint)Marshal.ReadInt32(buffer, 4));
                Program.Require(count <= capacity, "Job member list exceeds the queried allocation.");
                return Enumerable.Range(0, (int)count).Select(index => checked((uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64())).ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }
    internal static NamedPipeServerStream LocalServer(string leaf)
    {
        var sddl = "O:" + CurrentSid + "D:P(A;;0x001f019f;;;" + CurrentSid + ")";
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out var descriptor, out _), "ConvertStringSecurityDescriptorToSecurityDescriptorW(private fixture)");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), SecurityDescriptor = descriptor, InheritHandle = false };
            var handle = CreateNamedPipeW(@"\\.\pipe\" + leaf, 0x00000003 | 0x40000000 | 0x00080000, 0x00000008, 255, 0, 0, 0, ref attributes);
            Check(!handle.IsInvalid, "CreateNamedPipeW(private loopback)");
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
            catch { handle.Dispose(); throw; }
        }
        finally { LocalFree(descriptor); }
    }
    internal static object PipeSecurity(SafePipeHandle handle)
    {
        var result = GetSecurityInfo(handle, 6, 0x00000005, out _, out _, out _, out _, out var descriptor);
        if (result != 0) throw new Win32Exception(unchecked((int)result), "GetSecurityInfo(actual pipe) failed.");
        try
        {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0);
            var acl = security.DiscretionaryAcl;
            var aces = acl is null ? Array.Empty<object>() : acl.Cast<GenericAce>().Select(ace => new { qualifier = ace is QualifiedAce qualified ? qualified.AceQualifier.ToString() : ace.AceType.ToString(), flags = (int)ace.AceFlags, accessMask = ace is KnownAce known ? known.AccessMask : 0, sidMatchesCurrent = ace is KnownAce named && named.SecurityIdentifier.Value == CurrentSid }).Cast<object>().ToArray();
            return new { ownerMatchesCurrentSid = security.Owner?.Value == CurrentSid, daclPresent = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent), protectedDacl = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected), aceCount = acl?.Count ?? 0, aces };
        }
        finally { LocalFree(descriptor); }
    }
    internal static async Task WaitAsync(WaitHandle handle, CancellationToken token)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = ThreadPool.RegisterWaitForSingleObject(handle, (_, timedOut) => { if (!timedOut) completion.TrySetResult(); }, null, Timeout.Infinite, true);
        using var cancellation = token.Register(() => completion.TrySetCanceled(token));
        try { await completion.Task; }
        finally { registration.Unregister(null); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessId(SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeFileHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, SafeFileHandle targetProcess, out IntPtr target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeFileHandle process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeFileHandle token, int informationClass, IntPtr information, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverPid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientPid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeInfo(SafePipeHandle pipe, out uint flags, out uint outputBufferSize, out uint inputBufferSize, out uint maximumInstances);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeFileHandle CreateJobObjectW(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out Accounting information, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, IntPtr information, uint length, out uint returned);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outputBufferSize, uint inputBufferSize, uint defaultTimeout, ref SecurityAttributes security);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(SafePipeHandle handle, uint objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
