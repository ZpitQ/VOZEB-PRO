using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsSessionFixture;

internal static class Program
{
    internal static readonly UTF8Encoding Utf8 = new(false, true);
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    internal static string Self => Environment.ProcessPath ?? throw new InvalidDataException("fixture_executable_missing");
    internal static string Leaf(string prefix) => prefix + Guid.NewGuid().ToString("N");
    internal static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    internal static JsonElement Element(object? value) => JsonSerializer.SerializeToElement(value, Json);
    internal static string Text(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new InvalidDataException("fixture_string_missing");
    internal static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
    internal static void Write(object value) { Console.WriteLine(JsonSerializer.Serialize(value, Json)); Console.Out.Flush(); }
    internal static object Error(Exception error) => new { type = error.GetType().Name, message = error.Message, nativeError = error is Win32Exception native ? (int?)native.NativeErrorCode : null };
    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    internal static bool Equal(object? left, object? right) => JsonElement.DeepEquals(Element(left), Element(right));
    internal static bool ReaderPinEnabled
    {
        get
        {
            var value = Environment.GetEnvironmentVariable("ZEB_WINDOWS_EXECUTION_ADAPTER_READER_PIN");
            Require(value is null or "0" or "1", "fixture_reader_pin_flag");
            return value == "1";
        }
    }
    internal static JsonElement Parse(string text)
    {
        using var document = JsonDocument.Parse(text);
        RejectDuplicates(document.RootElement);
        return document.RootElement.Clone();
    }
    internal static void Exact(JsonElement value, params string[] names) => Require(value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(item => item.Name).Order(StringComparer.Ordinal).SequenceEqual(names.Order(StringComparer.Ordinal)), "fixture_exact_shape");
    private static void RejectDuplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject()) { Require(names.Add(property.Name), "fixture_duplicate_json_key"); RejectDuplicates(property.Value); }
        }
        else if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) RejectDuplicates(item);
    }
    private static int CreatePngBundle(string suppliedDirectory)
    {
        string directory = Path.GetFullPath(suppliedDirectory);
        Require(Directory.Exists(directory), "png_bundle_explicit_existing_case_directory");
        var bundle = new Bundle(Path.Combine(directory, "installation"));
        Probe.CreateDirectory(Path.Combine(directory, "records"));
        Probe.CreateDirectory(Path.Combine(directory, "data"));
        Write(new { kind = "png-bundle", root = bundle.Root, bundle.ManifestSha256, bundle.Selection,
            recipeTemplate = bundle.Arguments("__INPUT__", "__OUTPUT__") });
        return 0;
    }

    internal static async Task<string?> ReadLineAsync(StreamReader reader, CancellationToken token, StringBuilder? originalText = null)
    {
        var text = new StringBuilder();
        var character = new char[1];
        while (await reader.ReadAsync(character.AsMemory(), token) != 0)
        {
            originalText?.Append(character[0]);
            if (character[0] == '\n') { if (text.Length != 0 && text[^1] == '\r') text.Length--; return text.ToString(); }
            text.Append(character[0]);
        }
        Require(text.Length == 0, "fixture_eof_half_frame");
        return null;
    }
    internal static async Task SendAsync(Stream stream, object value, CancellationToken token)
    {
        var bytes = Utf8.GetBytes(JsonSerializer.Serialize(value, Json) + "\n");
        await stream.WriteAsync(bytes, token);
        await stream.FlushAsync(token);
    }
    private static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = Utf8;
        Console.OutputEncoding = Utf8;
        try
        {
            Require(OperatingSystem.IsWindows(), "windows_required");
            if (args.FirstOrDefault() == "-i") return await Engine.RecipeAsync(args);
            return args.FirstOrDefault() switch
            {
                "outer" when args.Length == 7 => await Outer.RunAsync(args[1], args[2], args[3], args[4], int.Parse(args[5], CultureInfo.InvariantCulture), int.Parse(args[6], CultureInfo.InvariantCulture)),
                "bridge-outer" when args.Length == 7 => await Outer.RunAsync(args[1], args[2], args[3], args[4], int.Parse(args[5], CultureInfo.InvariantCulture), int.Parse(args[6], CultureInfo.InvariantCulture), bridgeMode: true),
                "host" when args.Length == 7 => await Harness.RunAsync(args[1], args[2], args[3], args[4], long.Parse(args[5], CultureInfo.InvariantCulture), int.Parse(args[6], CultureInfo.InvariantCulture)),
                "bridge-host" when args.Length == 7 => await ControlBridgeHarness.RunAsync(args[1], args[2], args[3], args[4], long.Parse(args[5], CultureInfo.InvariantCulture), int.Parse(args[6], CultureInfo.InvariantCulture)),
                "agent" when args.Length == 4 => await Agent.RunAsync(uint.Parse(args[1], CultureInfo.InvariantCulture), args[2], long.Parse(args[3], CultureInfo.InvariantCulture)),
                "readback" when args.Length == 1 => await Readback.RunAsync(),
                "descendant" when args.Length == 3 => await Engine.DescendantAsync(args[1], args[2]),
                "png-bundle" when args.Length == 2 => CreatePngBundle(args[1]),
                "bridge-prepare-diagnostic" when args.Length == 2 => await BridgePrepareDiagnosticCases.RunAsync(args[1]),
                _ => throw new InvalidDataException("fixture_bootstrap")
            };
        }
        catch (Exception error) { Console.Error.WriteLine("fixture_failure/" + error.GetType().Name); return 1; }
    }
}

internal sealed record ProcessFact(uint Pid, string CreationFileTime);

internal sealed class ProcessPin : IDisposable
{
    internal SafeFileHandle Handle { get; }
    internal ProcessFact Identity { get; }
    internal bool Alive => !Probe.Signaled(Handle);
    internal bool Joined { get; private set; }
    internal bool NonInherited => Probe.NonInherited(Handle);
    internal bool SameSid { get; }
    internal int? ExitCode { get { if (Alive) return null; Probe.Check(Probe.GetExitCodeProcess(Handle, out var code), "process_exit_code"); return unchecked((int)code); } }
    private ProcessPin(SafeFileHandle handle)
    {
        Handle = handle;
        try
        {
            Probe.Check(!handle.IsInvalid, "process_pin_open");
            Identity = new(Probe.GetProcessId(handle), Probe.CreationTime(handle).ToString(CultureInfo.InvariantCulture));
            SameSid = Probe.ProcessSid(handle) == Probe.CurrentSid;
            Program.Require(Identity.Pid > 0 && NonInherited && SameSid, "process_pin_identity");
        }
        catch { handle.Dispose(); throw; }
    }
    internal static ProcessPin Open(uint pid, uint extra = 0) => new(Probe.OpenProcess(0x00101001 | extra, false, pid));
    internal static ProcessPin Adopt(SafeFileHandle handle, ProcessFact? expected = null)
    {
        var pin = new ProcessPin(handle);
        if (expected is not null && pin.Identity != expected) { pin.Dispose(); throw new InvalidDataException("process_original_identity_mismatch"); }
        return pin;
    }
    internal static ProcessPin Duplicate(SafeHandle original) => Adopt(Probe.DuplicateLocal(original));
    internal async Task WaitAsync(CancellationToken token) { await Probe.WaitProcessAsync(Handle, token); Joined = true; }
    internal void Terminate(uint code = 1)
    {
        if (!Alive) return;
        Program.Require((Probe.GrantedAccess(Handle) & 1) != 0, "original_process_terminate_right_missing");
        var success = Probe.TerminateProcess(Handle, code);
        var error = success ? 0 : Marshal.GetLastWin32Error();
        if (!success && Alive) throw new Win32Exception(error, "terminate_exact_original_process");
    }
    internal object Evidence() => new { identity = Identity, originalRetained = true, originalJoined = Joined, alive = Alive, nonInherited = NonInherited, sameSid = SameSid, exitCode = ExitCode };
    public void Dispose() => Handle.Dispose();
}

internal sealed class Capture
{
    private readonly List<string> lines = [];
    private readonly object gate = new();
    private readonly StringBuilder? originalText;
    internal TaskCompletionSource<string?> First { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal Task Completion { get; }
    internal bool Eof { get; private set; }
    internal string? Error { get; private set; }
    internal string[] Lines { get { lock (gate) return lines.ToArray(); } }
    internal string? OriginalText => originalText?.ToString();
    internal Capture(StreamReader reader, Action<string>? onLine = null, bool preserveFraming = false)
    {
        originalText = preserveFraming ? new StringBuilder() : null;
        Completion = DrainAsync(reader, onLine);
    }
    private async Task DrainAsync(StreamReader reader, Action<string>? onLine)
    {
        try
        {
            while (await Program.ReadLineAsync(reader, CancellationToken.None, originalText) is { } line)
            {
                lock (gate) lines.Add(line);
                First.TrySetResult(line);
                onLine?.Invoke(line);
            }
            Eof = true;
        }
        catch (Exception error) { Error = error.GetType().Name + ":" + error.Message; }
        finally { First.TrySetResult(null); reader.Dispose(); }
    }
}

// Every created child is registered before Start. Its original process object
// and both started stream tasks remain available even if retention throws.
internal sealed class Child : IDisposable
{
    private readonly Process process;
    internal ProcessPin? Pin { get; private set; }
    internal Capture? Output { get; private set; }
    internal Capture? Error { get; private set; }
    internal bool Started { get; private set; }
    internal bool OriginalJoined { get; private set; }
    private long? originalJoinedTick;
    internal bool Forced { get; private set; }
    internal RawCapture? RawOutput { get; private set; }
    internal RawCapture? RawError { get; private set; }
    private bool rawInputClosed;
    private readonly List<string> sentRawFrames = [];
    internal StreamWriter Input => process.StandardInput;
    internal SafeProcessHandle Original => process.SafeHandle;
    internal Child(string executable, string directory, params string[] args)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = Program.Utf8, StandardOutputEncoding = Program.Utf8, StandardErrorEncoding = Program.Utf8 };
        foreach (var argument in args) start.ArgumentList.Add(argument);
        process = new Process { StartInfo = start };
    }
    internal void Start(Action<string>? onLine = null, bool preserveFraming = false)
    {
        Program.Require(process.Start(), "child_start");
        Started = true;
        Output = new Capture(preserveFraming ? new StreamReader(process.StandardOutput.BaseStream, Program.Utf8, false) : process.StandardOutput, onLine, preserveFraming);
        Error = new Capture(preserveFraming ? new StreamReader(process.StandardError.BaseStream, Program.Utf8, false) : process.StandardError, preserveFraming: preserveFraming);
        Pin = ProcessPin.Duplicate(process.SafeHandle);
    }
    internal void SetTestEnvironment(string key, string value)
    {
        Program.Require(!Started, "raw_environment_before_original_start");
        process.StartInfo.Environment[key] = value;
    }
    internal void StartRaw(Action<byte[]> onFrame, RawReadGate? stdoutGate = null, int maximumCaptureBytes = 262144)
    {
        Program.Require(process.Start(), "raw_child_start");
        Started = true;
        RawOutput = new RawCapture(process.StandardOutput.BaseStream, onFrame, stdoutGate, maximumCaptureBytes);
        RawError = new RawCapture(process.StandardError.BaseStream);
        Pin = ProcessPin.Duplicate(process.SafeHandle);
    }
    internal async Task SendRawAsync(object value, CancellationToken token)
    {
        var bytes = Program.Utf8.GetBytes(JsonSerializer.Serialize(value, Program.Json) + "\n");
        await SendRawBytesAsync(bytes, token);
    }
    internal async Task SendRawBytesAsync(byte[] bytes, CancellationToken token)
    {
        sentRawFrames.Add(Convert.ToBase64String(bytes));
        await process.StandardInput.BaseStream.WriteAsync(bytes, token);
        await process.StandardInput.BaseStream.FlushAsync(token);
    }
    internal void CloseRawInput() { process.StandardInput.Close(); rawInputClosed = true; }
    internal bool RawInputClosed => rawInputClosed;
    internal int RawSendCount => sentRawFrames.Count;
    internal async Task SendAsync(object value, CancellationToken token)
    {
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(value, Program.Json).AsMemory(), token);
        await process.StandardInput.FlushAsync(token);
    }
    internal async Task JoinAsync(CancellationToken token)
    {
        if (!Started) return;
        await Probe.WaitProcessAsync(process.SafeHandle, token);
        OriginalJoined = true;
        originalJoinedTick ??= Environment.TickCount64;
        if (Pin is not null) await Pin.WaitAsync(token);
        if (RawOutput is not null)
        {
            await Task.WhenAll(RawOutput.Completion, RawError!.Completion).WaitAsync(token);
            Program.Require(RawOutput.Eof && RawError.Eof && RawOutput.Error is null && RawError.Error is null, "raw_child_true_dual_eof");
            return;
        }
        await Task.WhenAll(Output!.Completion, Error!.Completion).WaitAsync(token);
        Program.Require(Output.Eof && Error.Eof && Output.Error is null && Error.Error is null, "child_true_dual_eof");
    }
    internal void Terminate()
    {
        if (!Started || OriginalJoined) return;
        Forced = true;
        if (Pin is not null) Pin.Terminate();
        else if (!Probe.Signaled(process.SafeHandle)) Probe.Check(Probe.TerminateProcess(process.SafeHandle, 1), "terminate_retained_start_failure");
    }
    internal object Evidence() => new { identity = Pin?.Identity, started = Started, originalRetained = Started, originalJoined = OriginalJoined, alive = Started && !OriginalJoined, exitCode = OriginalJoined ? (int?)process.ExitCode : null, stdoutEof = Output?.Eof ?? false, stderrEof = Error?.Eof ?? false, stdoutError = Output?.Error, stderrError = Error?.Error, stdout = Output?.Lines ?? [], stderr = Error?.Lines ?? [], sameSid = Pin?.SameSid ?? false, nonInherited = Pin?.NonInherited ?? false, forced = Forced };
    internal object RawEvidence() => new { identity = Pin?.Identity, started = Started, originalRetained = Started, originalJoined = OriginalJoined, originalJoinedTick, alive = Started && !OriginalJoined, exitCode = OriginalJoined ? (int?)process.ExitCode : null, sameSid = Pin?.SameSid ?? false, nonInherited = Pin?.NonInherited ?? false, forced = Forced, stdinClosedByCaller = rawInputClosed, sentFramesBase64 = sentRawFrames.ToArray(), stdout = RawOutput?.Evidence(), stderr = RawError?.Evidence() };
    public void Dispose() { Pin?.Dispose(); process.Dispose(); }
}

// Dedicated bridge path: byte capture never goes through StreamReader/CRLF
// normalization. Reaching EOF requires an actual zero-length original read.
internal sealed class RawReadGate
{
    private readonly string probeId;
    private readonly TaskCompletionSource<object> paused = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource resumed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource settled = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool boundObserved, probeObserved, pauseAcknowledged;
    private int releaseCount;
    private object? pauseReceipt;
    private string? releaseReason;
    private long? releaseTick;
    internal RawReadGate(string probeId) => this.probeId = probeId;
    internal Task Completion => settled.Task;
    internal Task<object> PausedAsync(CancellationToken token) => paused.Task.WaitAsync(token);
    internal void Observe(JsonElement frame)
    {
        if (Program.Text(frame, "kind") == "bound") boundObserved = true;
        if (boundObserved && Program.Text(frame, "kind") == "state" && frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == probeId) probeObserved = true;
    }
    internal async Task AtReadBoundaryAsync(Stream stream, long rawBytesRead, int completeFrames, long pendingFrameBytes)
    {
        if (!probeObserved || pauseAcknowledged || Volatile.Read(ref releaseCount) != 0) return;
        pauseAcknowledged = true;
        var receipt = new { pauseSequence = 1, observedTick = Environment.TickCount64, rawBytesRead, completeFrames, pendingFrameBytes, originalReadInFlight = false, actualEof = false, streamLocallyClosed = false, originalPipe = PipeObservation(stream) };
        pauseReceipt = receipt; paused.TrySetResult(receipt);
        await resumed.Task;
    }
    internal bool ResumeOnce(string reason)
    {
        if (Interlocked.CompareExchange(ref releaseCount, 1, 0) != 0) return false;
        releaseReason = reason; releaseTick = Environment.TickCount64; resumed.TrySetResult(); return true;
    }
    internal void Finish()
    {
        if (!pauseAcknowledged)
        {
            paused.TrySetException(new InvalidDataException("stdout_read_gate_ended_before_pause"));
            _ = paused.Task.Exception; // Observe even a setup failure before the host waiter.
        }
        settled.TrySetResult();
    }
    internal object Evidence() => new { armedBeforeLaunch = true, boundObserved, probeObserved, pauseAcknowledged, pause = pauseReceipt, releaseCount = Volatile.Read(ref releaseCount), releaseReason, releaseTick, gateJoined = settled.Task.IsCompletedSuccessfully };
    internal static object PipeObservation(Stream stream)
    {
        SafeHandle? original = stream switch { FileStream file => file.SafeFileHandle, PipeStream pipe => pipe.SafePipeHandle, _ => null };
        if (original is null) return new { supportedOriginalHandle = false, originalStreamType = stream.GetType().FullName };
        var info = GetNamedPipeInfo(original, out var flags, out var outputSize, out var inputSize, out var maximumInstances);
        var infoError = info ? (int?)null : Marshal.GetLastWin32Error();
        var peek = PeekNamedPipe(original, IntPtr.Zero, 0, IntPtr.Zero, out var unreadBytes, IntPtr.Zero);
        var peekError = peek ? (int?)null : Marshal.GetLastWin32Error();
        return new { supportedOriginalHandle = true, originalStreamType = stream.GetType().FullName, infoSucceeded = info, infoError, flags, outputSize, inputSize, maximumInstances, peekSucceeded = peek, peekError, unreadBytes, capacityIsAdvisory = true, exactKernelWritePendingObserved = false, managedQueueOccupancyObserved = false };
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeInfo(SafeHandle pipe, out uint flags, out uint outputSize, out uint inputSize, out uint maximumInstances);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PeekNamedPipe(SafeHandle pipe, IntPtr buffer, uint size, IntPtr bytesRead, out uint bytesAvailable, IntPtr bytesLeft);
}

internal sealed class RawCapture
{
    private readonly int maximumCaptureBytes;
    private readonly RawReadGate? readGate;
    private readonly MemoryStream captured = new();
    private readonly List<string> frames = [];
    internal Task Completion { get; }
    internal bool Eof { get; private set; }
    private long? actualEofTick;
    internal bool Overflow { get; private set; }
    internal string? Error { get; private set; }
    internal RawCapture(Stream stream, Action<byte[]>? onFrame = null, RawReadGate? readGate = null, int maximumCaptureBytes = 262144)
    {
        Program.Require(maximumCaptureBytes > 0, "fixture_positive_raw_capture_limit");
        this.maximumCaptureBytes = maximumCaptureBytes; this.readGate = readGate;
        Completion = DrainAsync(stream, onFrame);
    }
    private async Task DrainAsync(Stream stream, Action<byte[]>? onFrame)
    {
        var pending = new MemoryStream();
        var bytes = new byte[4096];
        try
        {
            int count;
            while (true)
            {
                count = await stream.ReadAsync(bytes, CancellationToken.None);
                if (count == 0) break;
                for (var index = 0; index < count; index++)
                {
                    if (captured.Length >= maximumCaptureBytes)
                    {
                        Overflow = true; Error ??= "fixture_raw_capture_overflow";
                        continue; // Continue draining the actual original stream.
                    }
                    var value = bytes[index]; captured.WriteByte(value);
                    if (Overflow) continue;
                    pending.WriteByte(value);
                    if (value != 10) continue;
                    var frame = pending.ToArray(); pending.SetLength(0);
                    frames.Add(Convert.ToBase64String(frame));
                    try { onFrame?.Invoke(frame); }
                    catch (Exception error) { Error ??= error.GetType().Name + ":" + error.Message; }
                }
                // Process the complete returned original read, including any
                // partial following frame, before acknowledging a held reader.
                if (readGate is not null && !Overflow && Error is null) await readGate.AtReadBoundaryAsync(stream, captured.Length, frames.Count, pending.Length);
            }
            Eof = true;
            actualEofTick = Environment.TickCount64;
            if (pending.Length != 0) Error ??= "fixture_raw_eof_half_frame";
        }
        catch (Exception error) { Error ??= error.GetType().Name + ":" + error.Message; }
        finally { pending.Dispose(); readGate?.Finish(); }
    }
    internal long CapturedBytes => captured.Length;
    internal object Evidence() => new { actualEof = Eof, actualEofTick, error = Error, overflow = Overflow, capturedBase64 = Convert.ToBase64String(captured.ToArray()), framesBase64 = frames.ToArray() };
}

internal sealed class Frames
{
    private readonly List<JsonElement> items = [];
    private readonly object gate = new();
    private readonly SemaphoreSlim changed = new(0);
    private Exception? ended;
    internal void Add(JsonElement frame) { lock (gate) items.Add(frame.Clone()); changed.Release(); }
    internal void End(Exception? error = null)
    {
        lock (gate)
        {
            if (ended is not null) return;
            ended = error ?? new EndOfStreamException("fixture_frame_eof");
        }
        changed.Release();
    }
    internal JsonElement[] Snapshot { get { lock (gate) return items.ToArray(); } }
    internal async Task<JsonElement> AtAsync(int index, CancellationToken token)
    {
        while (true)
        {
            lock (gate)
            {
                if (items.Count > index) return items[index];
                if (ended is not null) throw ended;
            }
            await changed.WaitAsync(token);
        }
    }
    internal async Task<JsonElement> MatchAsync(Func<JsonElement, bool> predicate, CancellationToken token)
    {
        while (true)
        {
            lock (gate)
            {
                var found = items.FirstOrDefault(predicate);
                if (found.ValueKind != JsonValueKind.Undefined) return found;
                if (ended is not null) throw ended;
            }
            await changed.WaitAsync(token);
        }
    }
}

internal sealed class GuardDiagnosticProcess : IDisposable
{
    internal const uint QueryAndSynchronize = 0x00101000;
    private readonly SafeFileHandle handle;
    private readonly Dictionary<string, object?> observations = [];
    private readonly List<object> reuseChecks = [];
    private Dictionary<string, object?>? join;
    private bool released;
    internal uint CandidatePid { get; }
    internal ProcessFact? Identity { get; }
    internal bool BindingVerified { get; }
    internal bool QualifiedSystemConsole { get; }
    internal bool OriginalNotificationRetained { get; }
    internal bool QualifiedReaderCandidate { get; }
    internal Probe.FileIdentityValue? ImageIdentity { get; }
    internal bool Joined { get; private set; }
    internal bool? JoinedSignal { get; private set; }
    internal uint? ExitCode { get; private set; }
    private readonly bool? sameSid, nonInherited;
    internal bool CompleteOriginalJoin => Joined && JoinedSignal is true && ExitCode.HasValue;
    internal GuardDiagnosticProcess(uint candidatePid, SafeFileHandle handle, SafeFileHandle job, Probe.FileIdentityValue? expectedConsoleImage, CancellationToken token, CancellationToken? imageQueryToken = null, Probe.FileIdentityValue? expectedReaderImage = null, bool originalNotificationRetained = false)
    {
        CandidatePid = candidatePid; this.handle = handle;
        var pid = Read(observations, "actualPid", () => { var value = Probe.GetProcessId(handle); Probe.Check(value != 0, "diagnostic_original_process_id"); return value; }, token) as uint?;
        var created = Read(observations, "creationFileTime", () => Probe.CreationTime(handle).ToString(CultureInfo.InvariantCulture), token) as string;
        var sid = Read(observations, "actualSid", () => Probe.ProcessSid(handle), token) as string;
        sameSid = sid is null ? null : sid == Probe.CurrentSid;
        observations["sameSid"] = sameSid;
        var member = Read(observations, "sameOriginalJob", () => Probe.InJob(handle, job), token) as bool?;
        nonInherited = Read(observations, "nonInherited", () => Probe.NonInherited(handle), token) as bool?;
        var signaled = Read(observations, "signaled", () => Probe.Signaled(handle), token) as bool?;
        var imageQueries = new List<object>(); observations["imageQueries"] = imageQueries;
        var imagePath = Read(observations, "imagePath", () => Probe.ProcessImagePath(handle, imageQueries, imageQueryToken ?? token), token) as string;
        var imageIdentity = imagePath is null ? null : Read(observations, "imageFileIdentity", () => Probe.NativeImageFileIdentity(imagePath), token) as Probe.FileIdentityValue;
        ImageIdentity = imageIdentity;
        OriginalNotificationRetained = originalNotificationRetained;
        if (pid is > 0 && created is not null) Identity = new(pid.Value, created);
        BindingVerified = Identity?.Pid == candidatePid && member is true && nonInherited is true;
        QualifiedSystemConsole = BindingVerified && sameSid is true && signaled is false && expectedConsoleImage is not null && imageIdentity == expectedConsoleImage;
        QualifiedReaderCandidate = originalNotificationRetained && BindingVerified && sameSid is true && signaled is false && expectedReaderImage is not null && imageIdentity == expectedReaderImage;
        observations["expectedConsoleImage"] = expectedConsoleImage;
    }
    internal ProcessPin DuplicateReader(SafeFileHandle job, Probe.FileIdentityValue expectedImage)
    {
        Program.Require(!released && OriginalNotificationRetained && QualifiedReaderCandidate && ImageIdentity == expectedImage, "reader_original_notification_required");
        var pin = ProcessPin.Duplicate(handle);
        try
        {
            Program.Require(pin.Identity == Identity && pin.Alive && pin.NonInherited && pin.SameSid && Probe.InJob(pin.Handle, job), "reader_original_notification_identity");
            return pin;
        }
        catch { pin.Dispose(); throw; }
    }
    internal static object? Read(Dictionary<string, object?> target, string operation, Func<object?> read, CancellationToken token)
    {
        var startedTick = Environment.TickCount64;
        try
        {
            token.ThrowIfCancellationRequested();
            var value = read();
            target[operation] = new { success = true, startedTick, endedTick = Environment.TickCount64, value };
            return value;
        }
        catch (Exception error) { target[operation] = new { success = false, startedTick, endedTick = Environment.TickCount64, error = Program.Error(error) }; return null; }
    }
    internal bool TryReuse(uint candidatePid, SafeFileHandle job, CancellationToken token)
    {
        if (!BindingVerified || Identity?.Pid != candidatePid || released) return false;
        var facts = new Dictionary<string, object?>();
        var pid = Read(facts, "actualPid", () => { var value = Probe.GetProcessId(handle); Probe.Check(value != 0, "diagnostic_retained_process_id"); return value; }, token) as uint?;
        var created = Read(facts, "creationFileTime", () => Probe.CreationTime(handle).ToString(CultureInfo.InvariantCulture), token) as string;
        var signaled = Read(facts, "signaled", () => Probe.Signaled(handle), token) as bool?;
        var member = Read(facts, "sameOriginalJob", () => Probe.InJob(handle, job), token) as bool?;
        var actual = pid is > 0 && created is not null ? new ProcessFact(pid.Value, created) : null;
        var reused = actual == Identity && signaled is false && member is true;
        reuseChecks.Add(new { candidatePid, actual, reused, observations = facts });
        return reused;
    }
    internal async Task JoinAsync(CancellationToken token)
    {
        if (released) return;
        join = new() { ["startedTick"] = Environment.TickCount64, ["joined"] = false, ["forced"] = false, ["outcome"] = "pending" };
        try
        {
            await Probe.WaitProcessAsync(handle, token);
            Joined = true;
            join["joined"] = true;
            join["outcome"] = "joined";
            JoinedSignal = Read(join, "signaled", () => Probe.Signaled(handle), token) as bool?;
            ExitCode = Read(join, "exitCode", () => { Probe.Check(Probe.GetExitCodeProcess(handle, out var code), "diagnostic_original_exit_code"); return code; }, token) as uint?;
            if (!CompleteOriginalJoin) join["outcome"] = "unknown";
        }
        catch (Exception error) { join["outcome"] = "unknown"; join["error"] = Program.Error(error); }
        finally { Dispose(); join["handleReleased"] = released; join["endedTick"] = Environment.TickCount64; }
    }
    internal object OriginalConsoleEvidence() => new { role = "os-console-auxiliary", identity = Identity, originalRetained = true, originalJoined = Joined, alive = JoinedSignal is true ? (bool?)false : null, sameSid, nonInherited, exitCode = ExitCode, qualifiedSystemConsole = QualifiedSystemConsole, completeOriginalJoin = CompleteOriginalJoin, observations, join };
    internal object Evidence() => OriginalNotificationRetained
        ? new { candidatePid = CandidatePid, requestedAccess = QueryAndSynchronize, identity = Identity, bindingVerified = BindingVerified, qualifiedSystemConsole = QualifiedSystemConsole, observations, reuseChecks, join, handleReleased = released, originalNotificationRetained = true, independentCreationPin = false, qualifiedReaderCandidate = QualifiedReaderCandidate, imageIdentity = ImageIdentity }
        : new { candidatePid = CandidatePid, requestedAccess = QueryAndSynchronize, identity = Identity, bindingVerified = BindingVerified, qualifiedSystemConsole = QualifiedSystemConsole, observations, reuseChecks, join, handleReleased = released };
    public void Dispose() { if (released) return; handle.Dispose(); released = true; }
}

internal sealed class GuardConsoleObserver : IDisposable
{
    private static readonly UIntPtr JobKey = new(1), StopKey = new(2);
    private readonly Func<uint, SafeFileHandle, CancellationToken, bool> capture;
    private readonly CancellationTokenSource imageQueries = new();
    private readonly TaskCompletionSource started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<object> captureErrors = [];
    private readonly Dictionary<string, object?> startup = [], stop = [];
    private readonly SafeFileHandle? port;
    private readonly IntPtr originalPort;
    private readonly Task? observer;
    private object? observerError;
    private volatile bool portClosing;
    private bool stopped;
    internal GuardConsoleObserver(SafeFileHandle job, Func<uint, SafeFileHandle, CancellationToken, bool> capture)
    {
        this.capture = capture;
        try
        {
            port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            Probe.Check(!port.IsInvalid, "guard_console_create_completion_port");
            originalPort = port.DangerousGetHandle();
            Program.Require(Probe.NonInherited(port), "guard_console_port_inherited");
            var association = new CompletionPortAssociation { CompletionKey = JobKey, CompletionPort = originalPort };
            Probe.Check(AssociateCompletionPort(job, 7, ref association, (uint)Marshal.SizeOf<CompletionPortAssociation>()), "guard_console_associate_original_inactive_job");
            observer = Task.Factory.StartNew(Observe, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            started.Task.GetAwaiter().GetResult();
            startup["observerStartedBeforeHostAssignment"] = true;
        }
        catch (Exception error) { startup["error"] = Program.Error(error); Dispose(); }
    }
    private void Observe()
    {
        try
        {
            started.TrySetResult();
            while (!portClosing)
            {
                // A raw HANDLE permits closing this original port to wake a failed stop post.
                var success = GetQueuedCompletionStatus(originalPort, out var message, out var key, out var value, uint.MaxValue);
                if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), "guard_console_dequeue");
                if (key == StopKey && message == 0 && value == IntPtr.Zero) break;
                if (key != JobKey || message != 6) continue;
                var rawPid = unchecked((ulong)value.ToInt64());
                SafeFileHandle? handle = null;
                try
                {
                    Program.Require(rawPid is > 0 and <= uint.MaxValue, "guard_console_new_process_pid");
                    // Retain before any identity, image or SID query and before the collection lock.
                    handle = Probe.OpenProcess(GuardDiagnosticProcess.QueryAndSynchronize, false, (uint)rawPid);
                    Probe.Check(!handle.IsInvalid, "guard_console_query_sync_open_process");
                    if (capture((uint)rawPid, handle, imageQueries.Token)) handle = null;
                }
                catch (Exception error) { captureErrors.Add(new { candidatePid = rawPid.ToString(CultureInfo.InvariantCulture), error = Program.Error(error) }); }
                finally { handle?.Dispose(); }
            }
        }
        catch (Exception error) { observerError = Program.Error(error); }
        finally { started.TrySetResult(); }
    }
    internal object Evidence() => new { startup, stop, observerError, captureErrors = captureErrors.ToArray(), notificationDeliveryGuaranteed = false };
    public void Dispose()
    {
        if (stopped) return;
        stopped = true;
        // This token can cancel only the existing variable-size image query.
        imageQueries.Cancel();
        if (observer is not null)
        {
            var posted = false;
            try
            {
                posted = PostQueuedCompletionStatus(originalPort, 0, StopKey, IntPtr.Zero);
                stop["post"] = new { success = posted, nativeError = posted ? 0 : Marshal.GetLastWin32Error() };
            }
            catch (Exception error) { stop["postError"] = Program.Error(error); }
            if (!posted) { portClosing = true; port?.Dispose(); stop["closeToWakeDisposeAttempted"] = true; }
            try { observer.GetAwaiter().GetResult(); stop["observerJoined"] = true; }
            catch (Exception error) { stop["observerJoined"] = observer.IsCompleted; stop["joinError"] = Program.Error(error); }
        }
        else stop["observerJoined"] = false;
        port?.Dispose();
        stop["portWrapperClosed"] = port?.IsClosed;
        imageQueries.Dispose();
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct CompletionPortAssociation { internal UIntPtr CompletionKey; internal IntPtr CompletionPort; }
    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssociateCompletionPort(SafeFileHandle job, int informationClass, ref CompletionPortAssociation information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingPort, UIntPtr completionKey, uint concurrentThreads);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr value, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PostQueuedCompletionStatus(IntPtr port, uint message, UIntPtr key, IntPtr value);
}

internal sealed class Guard : IDisposable
{
    private readonly SafeFileHandle job;
    private readonly Dictionary<ProcessFact, ProcessPin> pins = [];
    private readonly List<object> registrationSources = [];
    private readonly List<ProcessPin> faultCleanupPins = [];
    private readonly object diagnosticGate = new();
    private readonly List<Dictionary<string, object?>> samples = [];
    private readonly List<GuardDiagnosticProcess> diagnosticProcesses = [];
    private readonly Dictionary<string, object?> expectedConsoleImage = [];
    private readonly Probe.FileIdentityValue? expectedConsoleIdentity;
    private readonly Probe.FileIdentityValue? expectedReaderIdentity;
    private readonly TaskCompletionSource<GuardDiagnosticProcess> readerCandidate = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private uint? readerRequestPid;
    private readonly Dictionary<string, object?> readerTransfer = [];
    private readonly GuardConsoleObserver consoleObserver;
    private readonly List<object> rejectedConsoleCandidates = [];
    internal bool Assigned { get; private set; }
    internal bool NonInherited { get; }
    internal bool OuterOutside { get; }
    internal Guard(CancellationToken token, string? readerImage = null)
    {
        job = Probe.CreateJobObjectW(IntPtr.Zero, null);
        Probe.Check(!job.IsInvalid, "outer_guard_create");
        NonInherited = Probe.NonInherited(job);
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        OuterOutside = !Probe.InJob(self.Handle, job);
        Program.Require(NonInherited && OuterOutside, "outer_guard_identity");
        Probe.KillOnClose(job);
        expectedConsoleIdentity = GuardDiagnosticProcess.Read(expectedConsoleImage, "capture", () =>
        {
            var systemDirectory = Environment.SystemDirectory;
            Program.Require(Path.IsPathFullyQualified(systemDirectory), "runtime_system_directory_required");
            var path = Path.Combine(systemDirectory, "conhost.exe");
            expectedConsoleImage["systemDirectory"] = systemDirectory; expectedConsoleImage["path"] = path;
            using var image = Probe.OpenFile(path);
            expectedConsoleImage["fileHandleNonInherited"] = Probe.NonInherited(image);
            return Probe.FileIdentity(image);
        }, token) as Probe.FileIdentityValue;
        if (readerImage is not null)
        {
            token.ThrowIfCancellationRequested();
            Program.Require(Path.IsPathFullyQualified(readerImage), "reader_fixed_image_path");
            using var image = Probe.OpenFile(readerImage);
            Program.Require(Probe.NonInherited(image), "reader_fixed_image_handle");
            expectedReaderIdentity = Probe.FileIdentity(image);
        }
        consoleObserver = new GuardConsoleObserver(job, CaptureConsole);
    }
    private bool CaptureConsole(uint pid, SafeFileHandle handle, CancellationToken imageQueryToken)
    {
        // Qualification never reads pins or waits for the registration ACK.
        var process = new GuardDiagnosticProcess(pid, handle, job, expectedConsoleIdentity, CancellationToken.None, imageQueryToken,
            expectedReaderIdentity, expectedReaderIdentity is not null);
        lock (diagnosticGate)
        {
            if (process.QualifiedSystemConsole || process.QualifiedReaderCandidate)
            {
                diagnosticProcesses.Add(process);
                if (process.QualifiedReaderCandidate && readerRequestPid == pid) readerCandidate.TrySetResult(process);
                return true;
            }
            process.Dispose();
            rejectedConsoleCandidates.Add(process.Evidence());
            return false;
        }
    }
    internal void Assign(Child host)
    {
        Probe.Check(Probe.AssignProcessToJobObject(job, host.Original), "outer_assign_original_host");
        Program.Require(Probe.InJob(host.Original, job), "outer_host_membership");
        var original = ProcessPin.Duplicate(host.Original);
        pins.Add(original.Identity, original);
        Assigned = true;
    }
    internal void Retain(ProcessFact expected, string source = "registered-test-identity-query")
    {
        if (pins.ContainsKey(expected)) return;
        Program.Require(source is "registered-test-identity-query" or "original-bridge-created-in-host" or "trusted-bridge-helper-query" or "direct-health-helper-created-in-host" or "test-barrier-helper-query" or "direct-sentinel-created-in-host" or "direct-ordinary-created-in-host", "outer_registration_source");
        var pin = ProcessPin.Open(expected.Pid);
        if (pin.Identity != expected || !Probe.InJob(pin.Handle, job)) { pin.Dispose(); throw new InvalidDataException("outer_registration_not_original_member"); }
        pins.Add(expected, pin);
        registrationSources.Add(new { identity = expected, source, testOnlyExactJobIdentityQuery = true, independentCreationPin = false });
    }
    internal async Task<(ProcessFact Identity, string OriginalHandle)> RetainObservedReaderAsync(uint candidatePid, ProcessPin host, CancellationToken token)
    {
        Program.Require(expectedReaderIdentity is not null && candidatePid > 0, "reader_registration_mode_pid");
        lock (diagnosticGate)
        {
            Program.Require(readerRequestPid is null, "reader_registration_once");
            readerRequestPid = candidatePid;
            var matches = diagnosticProcesses.Where(process => process.QualifiedReaderCandidate && process.CandidatePid == candidatePid).ToArray();
            Program.Require(matches.Length <= 1, "reader_notification_identity_ambiguous");
            if (matches.Length == 1) readerCandidate.TrySetResult(matches[0]);
        }
        var original = await readerCandidate.Task.WaitAsync(token);
        token.ThrowIfCancellationRequested();
        var pin = original.DuplicateReader(job, expectedReaderIdentity!);
        try
        {
            Program.Require(!pins.ContainsKey(pin.Identity) && host.Alive, "reader_original_registration_target");
            pins.Add(pin.Identity, pin);
        }
        catch { pin.Dispose(); throw; }
        registrationSources.Add(new { role = "journal-reader", identity = pin.Identity, source = "original-reader-job-notification",
            candidatePid, notificationSource = "original-job-new-process-notification", imageIdentity = original.ImageIdentity,
            originalNotificationRetained = true, independentCreationPin = false });
        readerTransfer["identity"] = pin.Identity;
        readerTransfer["originalHost"] = host.Identity;
        readerTransfer["state"] = "local-retained";
        try
        {
            token.ThrowIfCancellationRequested();
            var remote = Probe.DuplicateTo(pin.Handle.DangerousGetHandle(), host.Handle);
            // A remote numeric HANDLE is owned by this original host, never by Outer.
            readerTransfer["originalHandle"] = remote;
            readerTransfer["state"] = "transfer-unconfirmed";
            return (pin.Identity, remote);
        }
        catch (Exception error) { readerTransfer["error"] = Program.Error(error); throw; }
    }
    internal void ConfirmReaderAdoption(JsonElement receipt, ProcessPin host)
    {
        if (!receipt.TryGetProperty("values", out var values) || !values.TryGetProperty("reader", out var reader) || reader.ValueKind != JsonValueKind.Object) return;
        Program.Require(reader.GetProperty("adopted").GetBoolean() && reader.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == (readerTransfer["identity"] as ProcessFact) &&
            host.Identity == (readerTransfer["originalHost"] as ProcessFact), "reader_original_host_adoption_receipt");
        readerTransfer["state"] = "host-adopted";
    }
    internal void Sample(string stage, ProcessFact? trigger, CancellationToken token)
    {
        lock (diagnosticGate)
        {
            var operations = new Dictionary<string, object?>();
            var extraMembers = new List<Dictionary<string, object?>>();
            var sample = new Dictionary<string, object?> { ["sequence"] = samples.Count + 1, ["stage"] = stage, ["trigger"] = trigger, ["startedTick"] = Environment.TickCount64, ["sequentialObservations"] = true, ["operations"] = operations, ["extraMembers"] = extraMembers };
            samples.Add(sample);
            try
            {
                sample["registeredOriginals"] = pins.Keys.ToArray();
                sample["accounting"] = GuardDiagnosticProcess.Read(operations, "accounting", () =>
                {
                    var actual = Probe.JobAccounting(job);
                    return new { actual.TotalUserTime, actual.TotalKernelTime, actual.ThisPeriodTotalUserTime, actual.ThisPeriodTotalKernelTime, actual.TotalPageFaultCount, actual.TotalProcesses, actual.ActiveProcesses, actual.TotalTerminatedProcesses };
                }, token);
                var members = GuardDiagnosticProcess.Read(operations, "members", () => Probe.JobMembers(job, token), token) as uint[];
                sample["members"] = members;
                if (members is not null) foreach (var pid in members)
                {
                    var registered = false;
                    foreach (var pin in pins.Values.Where(pin => pin.Identity.Pid == pid))
                    {
                        var signaled = GuardDiagnosticProcess.Read(operations, "registeredSignal:" + pid.ToString(CultureInfo.InvariantCulture) + ":" + pin.Identity.CreationFileTime, () => Probe.Signaled(pin.Handle), token) as bool?;
                        if (signaled is false) { registered = true; break; }
                    }
                    if (registered) continue;
                    var extra = new Dictionary<string, object?> { ["observedMemberPid"] = pid, ["startedTick"] = Environment.TickCount64 };
                    extraMembers.Add(extra);
                    try
                    {
                        var existing = diagnosticProcesses.FirstOrDefault(process => process.TryReuse(pid, job, token));
                        if (existing is not null) { extra["reused"] = true; extra["diagnosticOrdinal"] = diagnosticProcesses.IndexOf(existing) + 1; continue; }
                        token.ThrowIfCancellationRequested();
                        SafeFileHandle? handle = null;
                        try
                        {
                            var startedTick = Environment.TickCount64;
                            try
                            {
                                handle = Probe.OpenProcess(GuardDiagnosticProcess.QueryAndSynchronize, false, pid);
                                Probe.Check(!handle.IsInvalid, "diagnostic_query_sync_open_process");
                                extra["open"] = new { success = true, requestedAccess = GuardDiagnosticProcess.QueryAndSynchronize, inherit = false, startedTick, endedTick = Environment.TickCount64 };
                            }
                            catch (Exception error) { extra["open"] = new { success = false, requestedAccess = GuardDiagnosticProcess.QueryAndSynchronize, inherit = false, startedTick, endedTick = Environment.TickCount64, error = Program.Error(error) }; throw; }
                            var process = new GuardDiagnosticProcess(pid, handle, job, expectedConsoleIdentity, token);
                            diagnosticProcesses.Add(process); handle = null;
                            extra["reused"] = false; extra["diagnosticOrdinal"] = diagnosticProcesses.Count; extra["identity"] = process.Identity; extra["bindingVerified"] = process.BindingVerified;
                        }
                        finally { handle?.Dispose(); }
                    }
                    catch (Exception error) { extra["error"] = Program.Error(error); }
                    finally { extra["endedTick"] = Environment.TickCount64; }
                }
            }
            catch (Exception error) { sample["error"] = Program.Error(error); }
            finally { sample["endedTick"] = Environment.TickCount64; }
        }
    }
    internal async Task JoinDiagnosticsAsync(CancellationToken token)
    {
        GuardDiagnosticProcess[] processes;
        lock (diagnosticGate) processes = diagnosticProcesses.ToArray();
        foreach (var process in processes) await process.JoinAsync(token);
    }
    internal object DiagnosticEvidence()
    {
        lock (diagnosticGate) return new { expectedConsoleImage, orderedSamples = samples.ToArray(), processes = diagnosticProcesses.Select(process => process.Evidence()).ToArray(), faultCleanupUnknowns = faultCleanupPins.Select(pin => pin.Evidence()).ToArray(), qualification = "original-job-sid-image-file-identity-and-original-join", expectedPinsRemainSeparate = true, consoleObservation = consoleObserver.Evidence(), rejectedConsoleCandidates = rejectedConsoleCandidates.ToArray(), registrationSources = registrationSources.ToArray(), readerTransfer };
    }
    internal async Task<object> FinishAsync(bool forced, CancellationToken token, List<object> failures)
    {
        consoleObserver.Dispose();
        if (forced)
        {
            foreach (var pid in Probe.JobMembers(job, token))
            {
                if (pins.Values.Any(pin => pin.Identity.Pid == pid && pin.Alive)) continue;
                // Query-only original OS auxiliaries are never individual kill candidates.
                // A PID conflict remains unproved; this skip cannot make the census pass.
                if (diagnosticProcesses.Any(process => process.QualifiedSystemConsole && process.Identity?.Pid == pid)) continue;
                var pin = ProcessPin.Open(pid);
                if (!Probe.InJob(pin.Handle, job)) { pin.Dispose(); throw new InvalidDataException("outer_cleanup_wrong_member"); }
                if (faultCleanupPins.Any(original => original.Identity == pin.Identity)) pin.Dispose(); else faultCleanupPins.Add(pin);
            }
            foreach (var pin in pins.Values.Concat(faultCleanupPins).Where(pin => pin.Alive)) { try { pin.Terminate(); } catch (Exception error) { failures.Add(Program.Error(error)); } }
        }
        foreach (var pin in pins.Values.Concat(faultCleanupPins)) { try { await pin.WaitAsync(token); } catch (Exception error) { failures.Add(Program.Error(error)); } }
        await JoinDiagnosticsAsync(token);
        var consoles = diagnosticProcesses.Where(process => process.QualifiedSystemConsole && process.Identity is not null && !pins.ContainsKey(process.Identity)).GroupBy(process => process.Identity!).ToArray();
        var completeCensus = pins.Count + consoles.Length;
        var accounting = Probe.JobAccounting(job);
        var active = accounting.ActiveProcesses;
        var members = Probe.JobMembers(job, token);
        var allJoined = active == 0 && members.Length == 0 && accounting.TotalProcesses == completeCensus && pins.Values.All(pin => pin.Joined && !pin.Alive) && consoles.All(group => group.All(process => process.CompleteOriginalJoin));
        if (!allJoined) failures.Add(Program.Error(new InvalidDataException("outer_original_guard_not_empty")));
        return new { activeProcesses = active, totalProcesses = accounting.TotalProcesses, registeredOriginalProcesses = completeCensus, expectedRegisteredProcesses = pins.Count, observedOsConsoleProcesses = consoles.Length, duplicateConsoleHandles = consoles.Sum(group => group.Count() - 1), membershipVerified = Assigned, nonInherited = NonInherited, outerOutsideJob = OuterOutside, soleJobHandle = true, killOnClose = true, allObservedJoined = allJoined, failures, processes = pins.Values.Select(pin => pin.Evidence()).Concat(consoles.Select(group => group.First().OriginalConsoleEvidence())).ToArray() };
    }
    public void Dispose() { consoleObserver.Dispose(); foreach (var process in diagnosticProcesses) process.Dispose(); foreach (var pin in faultCleanupPins) pin.Dispose(); foreach (var pin in pins.Values) pin.Dispose(); job.Dispose(); }
}

internal static class Outer
{
    internal static async Task<int> RunAsync(string ordinary, string test, string ordinaryDll, string directory, int executionMs, int cleanupMs, bool bridgeMode = false)
    {
        Program.Require(executionMs > 0 && cleanupMs > 0 && Path.IsPathFullyQualified(directory), "outer_budget_path");
        using var execution = new CancellationTokenSource(executionMs);
        var absoluteCleanup = checked(Environment.TickCount64 + executionMs + cleanupMs);
        var readerPinEnabled = Program.ReaderPinEnabled;
        Program.Require(!readerPinEnabled || bridgeMode, "reader_pin_bridge_fixture_only");
        using var guard = new Guard(execution.Token, readerPinEnabled ? test : null);
        using var host = new Child(Program.Self, directory, bridgeMode ? "bridge-host" : "host", ordinary, test, ordinaryDll, directory, (absoluteCleanup - cleanupMs).ToString(CultureInfo.InvariantCulture), cleanupMs.ToString(CultureInfo.InvariantCulture));
        var frames = new Frames();
        var writes = new SemaphoreSlim(1);
        var protocolErrors = new List<object>();
        Task pump = Task.CompletedTask;
        using var forwarding = new CancellationTokenSource();
        object? primary = null;
        JsonElement? receipt = null;
        var forced = false;
        long cleanupAt = 0;
        var cleanupSampled = 0;
        async Task Send(object value, CancellationToken token)
        {
            await writes.WaitAsync(token);
            try { await host.SendAsync(value, token); } finally { writes.Release(); }
        }
        try
        {
            host.Start(line => frames.Add(Program.Parse(line)));
            guard.Assign(host);
            guard.Sample("host-assigned", host.Pin!.Identity, execution.Token);
            var ready = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "host-ready", execution.Token);
            Program.Require(ready.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == host.Pin!.Identity && ready.GetProperty("actorLaunches").GetInt32() == 0, "outer_host_ready_binding");
            Program.Write(new { kind = "outer-ready", host = ready, hostMembershipVerified = guard.Assigned, guardHandleNonInherited = guard.NonInherited, outerOutsideJob = guard.OuterOutside, firstCommandBarrier = true });
            pump = Task.Run(async () =>
            {
                var seen = 0;
                while (true)
                {
                    var item = await frames.AtAsync(seen++, forwarding.Token);
                    switch (Program.Text(item, "kind"))
                    {
                        case "host-ready": break;
                        case "registered":
                            if (item.TryGetProperty("registrationSource", out var readerSource) && readerSource.GetString() == "original-reader-job-notification")
                            {
                                Program.Require(readerPinEnabled, "reader_registration_disabled");
                                Program.Exact(item, "kind", "registrationSource", "candidatePid");
                                var reader = await guard.RetainObservedReaderAsync(item.GetProperty("candidatePid").GetUInt32(), host.Pin!, forwarding.Token);
                                guard.Sample("reader-registered-retained", reader.Identity, forwarding.Token);
                                await Send(new { registrationAck = reader.Identity, registrationSource = "original-reader-job-notification", originalHandle = reader.OriginalHandle }, forwarding.Token);
                                break;
                            }
                            var identity = item.GetProperty("identity").Deserialize<ProcessFact>(Program.Json)!;
                            guard.Retain(identity, item.TryGetProperty("registrationSource", out var registrationSource) ? registrationSource.GetString()! : "registered-test-identity-query");
                            guard.Sample("registered-retained", identity, forwarding.Token);
                            await Send(new { registrationAck = identity }, forwarding.Token);
                            break;
                        case "metadata": Program.Write(new { kind = "outer-metadata", value = item.GetProperty("value") }); break;
                        case "host-cleanup-start":
                            cleanupAt = Math.Min(item.GetProperty("deadlineTick").GetInt64(), absoluteCleanup);
                            if (Interlocked.CompareExchange(ref cleanupSampled, 1, 0) == 0) guard.Sample("host-cleanup-observed", null, forwarding.Token);
                            Program.Write(new { kind = "outer-cleanup-start", deadlineUnixMs = Program.Now + Math.Max(0, cleanupAt - Environment.TickCount64) });
                            await writes.WaitAsync(forwarding.Token);
                            try { host.Input.Close(); } finally { writes.Release(); }
                            break;
                        case "receipt":
                            receipt = item.GetProperty("value").Clone();
                            if (readerPinEnabled) guard.ConfirmReaderAdoption(receipt.Value, host.Pin!);
                            return;
                        default: throw new InvalidDataException("outer_unknown_host_frame");
                    }
                }
            });
            // Exactly two human-harness frames are needed. Do not leave a
            // blocked anonymous-stdin reader waiting for an optional EOF while
            // the caller is waiting for our final receipt.
            using var input = new StreamReader(Console.OpenStandardInput(), Program.Utf8, false, leaveOpen: true);
            for (var commandNo = 0; commandNo < 2; commandNo++)
            {
                var line = await Program.ReadLineAsync(input, execution.Token);
                Program.Require(line is not null, "outer_input_eof_before_carrier");
                var command = Program.Parse(line!);
                if (readerPinEnabled && commandNo == 0)
                {
                    Program.Exact(command, "scenario");
                    Program.Require(Program.Text(command, "scenario") is "execution-node-natural" or "execution-node-stop-soft" or
                        "execution-node-reader-loss-before-input" or "execution-node-reader-loss-after-input", "reader_pin_adapter_scenario_only");
                }
                await Send(command, execution.Token);
            }
            await pump.WaitAsync(execution.Token);
            Program.Require(receipt.HasValue, "outer_host_ended_before_receipt");
        }
        catch (Exception error) { primary = Program.Error(error); forced = true; }
        forwarding.Cancel();
        cleanupAt = Math.Min(cleanupAt == 0 ? Environment.TickCount64 + cleanupMs : cleanupAt, absoluteCleanup);
        Program.Write(new { kind = "outer-cleanup-start", deadlineUnixMs = Program.Now + Math.Max(0, cleanupAt - Environment.TickCount64) });
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupAt - Environment.TickCount64)));
        var failures = new List<object>();
        try { await pump.WaitAsync(cleanup.Token); } catch (OperationCanceledException) when (forwarding.IsCancellationRequested) { } catch (Exception error) { failures.Add(Program.Error(error)); }
        if (Interlocked.CompareExchange(ref cleanupSampled, 1, 0) == 0) guard.Sample("outer-cleanup-entry", null, cleanup.Token);
        if (forced) { try { host.Terminate(); } catch (Exception error) { failures.Add(Program.Error(error)); } }
        try { if (host.Started) host.Input.Close(); await host.JoinAsync(cleanup.Token); } catch (Exception error) { failures.Add(Program.Error(error)); }
        object guardEvidence;
        try { guardEvidence = await guard.FinishAsync(forced, cleanup.Token, failures); }
        catch (Exception error) { failures.Add(Program.Error(error)); guardEvidence = new { activeProcesses = (uint?)null, membershipVerified = guard.Assigned, nonInherited = guard.NonInherited, outerOutsideJob = guard.OuterOutside, soleJobHandle = true, killOnClose = true, allObservedJoined = false, failures, processes = Array.Empty<object>() }; }
        await guard.JoinDiagnosticsAsync(cleanup.Token);
        Program.Write(new { kind = "outer-receipt", value = new { host = receipt, outer = new { primaryFailure = primary, forcedFallback = forced, firstCommandBarrier = true, host = host.Evidence(), guard = guardEvidence, guardDiagnostics = guard.DiagnosticEvidence(), protocolErrors } } });
        return failures.Count == 0 ? 0 : 1;
    }
}

// This host is released only after the existing Outer assigned its exact Job.
// It retains bridge creation handles; helper identity below is only a trusted
// bridge statement plus the guardian's separately labeled exact-Job query.
internal static class ControlBridgeHarness
{
    private sealed class TestHelperBarrier : IDisposable
    {
        internal string Leaf { get; } = Program.Leaf("zeb-fixture-control-");
        private readonly NamedPipeServerStream pipe;
        private readonly Frames frames = new();
        private RawCapture? capture;
        internal ProcessPin? QueryPin { get; private set; }
        internal bool ActualEof { get; private set; }
        internal TestHelperBarrier() => pipe = Probe.LocalServer(Leaf, true);
        internal async Task BindAsync(Frames commands, CancellationToken token)
        {
            await pipe.WaitForConnectionAsync(token);
            var bytes = await ReadOneAsync(pipe, token);
            var hello = ParseRawFrame(bytes);
            Program.Exact(hello, "v", "kind", "identity", "mode");
            Program.Require(hello.GetProperty("v").GetInt32() == 1 && Program.Text(hello, "kind") == "helper-barrier", "fault_barrier_exact_hello");
            var expected = hello.GetProperty("identity").Deserialize<ProcessFact>(Program.Json)!;
            Probe.Check(Probe.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var actualPid), "fault_barrier_actual_client_pid");
            QueryPin = ProcessPin.Open(actualPid);
            Program.Require(QueryPin.Identity == expected && QueryPin.SameSid && QueryPin.NonInherited && QueryPin.Alive, "fault_barrier_actual_identity_query");
            await RegisterAsync(expected, "test-barrier-helper-query", commands, token);
            Program.Require(QueryPin.Alive, "fault_barrier_still_live_after_job_registration");
        }
        internal async Task ReleaseAsync(CancellationToken token)
        {
            var originalCapture = new RawCapture(pipe, bytes => frames.Add(ParseRawFrame(bytes)));
            capture = originalCapture;
            _ = originalCapture.Completion.ContinueWith(_ => frames.End(originalCapture.Error is null ? null : new InvalidDataException(originalCapture.Error)), TaskScheduler.Default);
            await Program.SendAsync(pipe, new { v = 1, kind = "continue" }, token);
            await frames.MatchAsync(frame => Program.Text(frame, "kind") == "barrier-released", token);
        }
        internal Task<JsonElement> StageAsync(string stage, CancellationToken token) => frames.MatchAsync(frame => Program.Text(frame, "kind") == "fault-stage" && Program.Text(frame, "stage") == stage, token);
        internal Task ReleaseDuplicateAsync(CancellationToken token) => Program.SendAsync(pipe, new { v = 1, kind = "release-duplicate" }, token);
        internal Task ReleaseStdoutEofAsync(CancellationToken token) => Program.SendAsync(pipe, new { v = 1, kind = "release-stdout-eof" }, token);
        internal Task EmitAsync(string batchId, int count, CancellationToken token) => Program.SendAsync(pipe, new { v = 1, kind = "emit-events", batchId, count }, token);
        internal Task<JsonElement> EmitterStageAsync(string stage, CancellationToken token) => frames.MatchAsync(frame => Program.Text(frame, "kind") == "emitter-stage" && Program.Text(frame, "stage") == stage, token);
        internal async Task JoinAsync(CancellationToken token) { if (capture is not null) { await capture.Completion.WaitAsync(token); ActualEof = capture.Eof; Program.Require(ActualEof && capture.Error is null, "fault_barrier_actual_eof_join"); } if (QueryPin is not null) await QueryPin.WaitAsync(token); }
        internal object Evidence() => new { testOnlyIdentityQuery = true, independentCreationPin = false, actualEof = ActualEof, query = QueryPin?.Evidence(), capture = capture?.Evidence() };
        public void Dispose() { pipe.Dispose(); QueryPin?.Dispose(); }
    }
    private static async Task<byte[]> ReadOneAsync(Stream input, CancellationToken token)
    {
        using var bytes = new MemoryStream(); var one = new byte[1];
        while (await input.ReadAsync(one, token) != 0)
        {
            Program.Require(bytes.Length < 65536, "fixture_test_frame_limit"); bytes.WriteByte(one[0]);
            if (one[0] == 10) return bytes.ToArray();
        }
        throw new EndOfStreamException("fixture_test_frame_missing");
    }
    private static JsonElement ParseRawReady(byte[] bytes)
    {
        Program.Require(bytes.Length > 2 && bytes[^1] == 10 && bytes[^2] == 13 && !bytes.AsSpan(0, bytes.Length - 2).Contains((byte)13), "ordinary_ready_actual_crlf");
        return ParseRawFrame(bytes.AsSpan(0, bytes.Length - 2).ToArray().Concat(new byte[] { 10 }).ToArray());
    }
    private static JsonElement ParseRawFrame(byte[] bytes)
    {
        Program.Require(bytes.Length > 1 && bytes[^1] == 10 && !bytes.AsSpan(0, bytes.Length - 1).Contains((byte)10) && !bytes.Contains((byte)13), "bridge_fixture_exact_lf_frame");
        Program.Require(!bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }), "bridge_fixture_no_bom");
        return Program.Parse(Program.Utf8.GetString(bytes.AsSpan(0, bytes.Length - 1)));
    }
    private static string[] Inventory(string path) => Directory.EnumerateFileSystemEntries(path, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal).Select(entry => Path.GetRelativePath(path, entry) + (Directory.Exists(entry) ? "/" : ":" + Program.Hash(File.ReadAllBytes(entry)))).ToArray();
    private static async Task RegisterAsync(ProcessFact fact, string source, Frames input, CancellationToken token)
    {
        Program.Write(new { kind = "registered", identity = fact, registrationSource = source });
        await input.MatchAsync(frame => frame.TryGetProperty("registrationAck", out var actual) && actual.Deserialize<ProcessFact>(Program.Json) == fact, token);
    }
    private static Dictionary<string, string> HelperEnvironment()
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // Only loader/temporary-directory inputs. No inherited secret values
        // or arbitrary environment values are copied into a receipt.
        foreach (var key in new[] { "SystemRoot", "WINDIR", "TEMP", "TMP" })
            if (Environment.GetEnvironmentVariable(key) is { } value) result.Add(key, value);
        return result;
    }
    private static string FaultMode(string scenario) => scenario switch
    {
        "matrix-pending-close" => "hold-inspect",
        "matrix-no-ready" => "no-ready",
        "matrix-invalid-ready" => "invalid-ready",
        "matrix-malformed-ready" => "malformed-ready",
        "matrix-duplicate-ready" => "duplicate-ready-key",
        "matrix-wrong-id" => "wrong-response-id",
        "matrix-wrong-op" => "wrong-response-op",
        "matrix-wrong-execution" => "wrong-response-execution",
        "matrix-wrong-role" => "wrong-response-role",
        "matrix-duplicate-response" => "duplicate-response-key",
        "matrix-duplicate-response-frame" => "duplicate-response-frame",
        "matrix-native-crlf" => "native-response-crlf",
        "matrix-stdout-extra" => "stdout-extra",
        "matrix-stdout-overflow" => "stdout-overflow",
        "matrix-stderr-payload" => "stderr-payload",
        "matrix-response-overflow" => "response-overflow",
        "matrix-held-live" => "held-live",
        "matrix-one-sided-eof" => "one-sided-eof",
        "output-session-high" or "output-session-low" or "output-queue-high" or "output-queue-low" or "output-held-close" => "output-budget",
        _ => "controlled",
    };
    private static bool Matrix(string scenario) => OutputScenario(scenario) || scenario is "matrix-controlled" or "matrix-eof-before-ready" or "matrix-eof-after-bound" or "matrix-pending-close" or "matrix-withheld-eof" or "matrix-deadline" or "matrix-forbidden-prepare" or "matrix-forbidden-authorize" or "matrix-forbidden-raw" or "matrix-extra-field" or "matrix-duplicate-key" or "matrix-duplicate-id" or "matrix-input-overflow" or "matrix-session-input-overflow" or "matrix-no-ready" or "matrix-invalid-ready" or "matrix-malformed-ready" or "matrix-duplicate-ready" or "matrix-wrong-id" or "matrix-wrong-op" or "matrix-wrong-execution" or "matrix-wrong-role" or "matrix-duplicate-response" or "matrix-duplicate-response-frame" or "matrix-native-crlf" or "matrix-stdout-extra" or "matrix-stdout-overflow" or "matrix-stderr-payload" or "matrix-response-overflow" or "matrix-held-live" or "matrix-one-sided-eof";
    private static bool PreboundFault(string scenario) => scenario is "matrix-eof-before-ready" or "matrix-no-ready" or "matrix-invalid-ready" or "matrix-malformed-ready" or "matrix-duplicate-ready" or "matrix-stdout-extra" or "matrix-stdout-overflow" or "matrix-stderr-payload";
    private static bool OutputScenario(string scenario) => scenario is "output-session-high" or "output-session-low" or "output-queue-high" or "output-queue-low" or "output-held-close";
    private static bool OutputLow(string scenario) => scenario is "output-session-low" or "output-queue-low";
    private const int OutputResponseBytes = 512, OutputEventCount = 64;
    private const int OutputExecutionMs = 60000, OutputCleanupMs = 15000;
    private static readonly int OutputUpperBytes = checked(OutputResponseBytes * (OutputEventCount + 5));
    private static readonly int OutputHighBytes = checked(OutputUpperBytes + OutputResponseBytes);
    private static readonly int OutputTranscriptBytes = checked(OutputResponseBytes * (OutputEventCount + 12) * 4 + OutputEventCount * 1024 + 32768);
    private static readonly int OutputOuterBytes = checked(8 * (OutputTranscriptBytes + OutputHighBytes) + 1048576);
    private static object OutputSnapshot() => new { phase = "claimed", sealReason = (string?)null, requestFingerprint = (string?)null, descriptor = (object?)null, authorizationVerified = false, resumeState = "not-attempted", evidenceOutcome = "pending", completion = (string?)null };
    private static void OutputShapeBudgets(Dictionary<string, object?> values, string scenario, long deadlineTick, int cleanupMs)
    {
        var executionId = new string('a', 32); var requestId = new string('b', 32);
        var identity = new ProcessFact(uint.MaxValue, ulong.MaxValue.ToString(CultureInfo.InvariantCulture));
        var snapshot = OutputSnapshot();
        var longestSnapshot = new { phase = "unknown", sealReason = "control_write_failure", requestFingerprint = (string?)null, descriptor = (object?)null, authorizationVerified = false, resumeState = "not-attempted", evidenceOutcome = "unknown", completion = (string?)null };
        object[] completeShapes = [
            new { v = 1, kind = "bound", executionId, bridge = identity, helper = identity, state = snapshot },
            new { v = 1, kind = "state", requestId, executionId, state = snapshot },
            new { v = 1, kind = "state", requestId = (string?)null, executionId, state = snapshot },
            new { v = 1, kind = "unknown", requestId, executionId },
            new { v = 1, kind = "closed", requestId, executionId, outcome = "stopped" },
            new { v = 1, kind = "ready", executionId },
            new { v = 1, kind = "response", requestId, op = "inspect", executionId, role = "observer", state = snapshot },
            new { v = 1, kind = "event", @event = "state", executionId, state = snapshot },
            new { v = 1, kind = "bound", executionId, bridge = identity, helper = identity, state = longestSnapshot },
            new { v = 1, kind = "state", requestId, executionId, state = longestSnapshot },
            new { v = 1, kind = "response", requestId, op = "inspect", executionId, role = "observer", state = longestSnapshot },
        ];
        var sizes = completeShapes.Select(shape => Program.Utf8.GetByteCount(JsonSerializer.Serialize(shape, Program.Json) + "\n")).ToArray();
        Program.Require(sizes.Max() <= OutputResponseBytes && cleanupMs == OutputCleanupMs && deadlineTick - Environment.TickCount64 <= OutputExecutionMs, "output_explicit_shape_and_host_budgets");
        var session = scenario == "output-session-low" ? checked(3 * OutputResponseBytes) : OutputHighBytes;
        var queued = scenario == "output-queue-low" ? checked(2 * OutputResponseBytes) : OutputHighBytes;
        Program.Require(session >= OutputResponseBytes && queued >= checked(2 * OutputResponseBytes) && OutputHighBytes > OutputUpperBytes && OutputTranscriptBytes <= 1048576 && OutputOuterBytes <= 4194304, "output_derived_limit_relationships");
        values["outputLimits"] = new { responseFrameBytes = OutputResponseBytes, eventCount = OutputEventCount, upperOutputBytes = OutputUpperBytes, highOutputBytes = OutputHighBytes, sessionOutputBytes = session, queuedOutputBytes = queued, rawCaptureBytes = OutputHighBytes, transcriptBytes = OutputTranscriptBytes, outerCaptureBytes = OutputOuterBytes, maximumSchemaFrameBytes = sizes.Max(), minimumStateFrameBytes = sizes[2], nativeSessionTimeoutMs = checked(OutputExecutionMs + OutputCleanupMs + 1), hostDeadlineTick = deadlineTick, hostCleanupDeadlineTick = checked(deadlineTick + cleanupMs) };
    }
    private static async Task OutputCommandsAsync(string scenario, Child child, JsonElement bound, Frames frames, TestHelperBarrier barrier, RawReadGate? readGate, Child? sentinel, Dictionary<string, object?> values, CancellationToken token)
    {
        const string inspectId = "00000000000000000000000000000001", closeId = "00000000000000000000000000000002";
        var executionId = Program.Text(bound, "executionId"); var batch = Guid.NewGuid().ToString("N");
        var query = barrier.QueryPin ?? throw new InvalidDataException("output_retained_helper_query_missing");
        var stages = new List<object>(); values["outputStages"] = stages;
        values["inspectRequestId"] = inspectId; values["closeRequestId"] = closeId; values["outputBatchId"] = batch;
        void Mark(string stage) => stages.Add(new { stage, observedTick = Environment.TickCount64, callerInputClosed = child.RawInputClosed, callerSendCount = child.RawSendCount });
        object Command(string op, string id) => new { v = 1, kind = "command", requestId = id, op, executionId };
        async Task<JsonElement> BatchStage(string stage)
        {
            var value = await barrier.EmitterStageAsync(stage, token);
            Program.Require(value.GetProperty("v").GetInt32() == 1 && Program.Text(value, "batchId") == batch, "output_exact_batch_correlation"); return value;
        }
        async Task AllEvents()
        {
            await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" && frame.GetProperty("requestId").ValueKind == JsonValueKind.Null && frames.Snapshot.Count(item => Program.Text(item, "kind") == "state" && item.GetProperty("requestId").ValueKind == JsonValueKind.Null) == OutputEventCount, token);
            Program.Require(frames.Snapshot.All(frame => Program.Text(frame, "kind") is "bound" or "state"), "output_high_control_not_resource_healthy");
            Mark("all-events-delivered-before-close");
        }
        async Task SettleHelper(int stopCount)
        {
            var settled = await BatchStage("output-tasks-settled");
            Program.Exact(settled, "v", "kind", "stage", "batchId", "eventsAttempted", "eventsWritten", "eventsCompleted", "bytesWritten", "nativeStopCount", "controlJoined", "emitterJoined", "connectionsJoined", "outputHelperFailure");
            Program.Require(settled.GetProperty("nativeStopCount").GetInt32() == stopCount && settled.GetProperty("controlJoined").GetBoolean() && settled.GetProperty("emitterJoined").GetBoolean() && settled.GetProperty("connectionsJoined").GetBoolean() && !settled.GetProperty("outputHelperFailure").GetBoolean(), "output_helper_tasks_must_settle_without_fault");
            values["outputTasksSettled"] = settled; Mark("helper-tasks-settled");
            await barrier.JoinAsync(token);
            Program.Require(query.Joined && query.ExitCode == 0 && barrier.ActualEof, "output_helper_natural_zero_and_true_barrier_eof"); Mark("helper-query-and-barrier-joined");
        }
        try
        {
            await child.SendRawAsync(Command("inspect", inspectId), token);
            var probe = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" && frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == inspectId, token);
            Program.Exact(probe, "v", "kind", "requestId", "executionId", "state");
            Program.Require(Program.Text(probe, "executionId") == executionId && Program.Equal(probe.GetProperty("state"), OutputSnapshot()) && query.Alive, "output_actual_correlated_positive_probe");
            Program.Require(frames.Snapshot.Length == 2 && Program.Text(frames.Snapshot[0], "kind") == "bound", "output_quiet_legal_prefix_required");
            values["outputPositiveProbe"] = probe; values["outputReadPolicy"] = readGate is null ? "continuous" : "pause-after-positive-probe"; Mark("positive-probe-observed");
            if (readGate is not null) { values["outputPause"] = await readGate.PausedAsync(token); Mark("original-stdout-paused"); }
            var originalOutput = child.RawOutput ?? throw new InvalidDataException("output_original_stdout_missing");
            values["outputPrefixBytes"] = originalOutput.CapturedBytes;
            Program.Require(originalOutput.CapturedBytes < checked(3 * OutputResponseBytes), "output_low_session_above_actual_prefix");
            await barrier.EmitAsync(batch, OutputEventCount, token); Mark("finite-load-command-written");
            var started = await BatchStage("batch-started");
            Program.Exact(started, "v", "kind", "stage", "batchId", "declaredEvents", "nativeEventBytes");
            Program.Require(started.GetProperty("declaredEvents").GetInt32() == OutputEventCount && started.GetProperty("nativeEventBytes").GetInt32() <= OutputResponseBytes, "output_finite_legal_event_shape");
            values["outputBatchStarted"] = started; Mark("batch-started");
            if (OutputLow(scenario))
            {
                var witness = await BatchStage("autonomous-owner-closure");
                Program.Exact(witness, "v", "kind", "stage", "batchId", "readOutcome", "nativeError", "localCancellation", "originalPipeLocallyClosing", "eventsAttempted", "eventsWritten", "identity");
                var zeroRead = Program.Text(witness, "readOutcome") == "zero-read" && witness.GetProperty("nativeError").ValueKind == JsonValueKind.Null;
                var remoteBroken = Program.Text(witness, "readOutcome") == "remote-broken-pipe-read" && witness.GetProperty("nativeError").GetInt32() is 109 or 232 or 233;
                Program.Require((zeroRead || remoteBroken) && !witness.GetProperty("localCancellation").GetBoolean() && !witness.GetProperty("originalPipeLocallyClosing").GetBoolean() && witness.GetProperty("eventsAttempted").GetInt32() > 0 && witness.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == query.Identity && !child.RawInputClosed && child.RawSendCount == 1, "output_autonomous_failure_before_any_caller_close_or_eof");
                values["outputAutonomousWitness"] = witness; Mark("autonomous-owner-closure-before-caller-eof");
                await SettleHelper(0);
                child.CloseRawInput(); Mark("caller-real-eof-after-independent-witness");
                if (readGate is not null) { Program.Require(readGate.ResumeOnce("scenario-after-autonomous-witness"), "output_resume_once"); Mark("original-stdout-resumed"); }
                return;
            }
            var written = await BatchStage("batch-written");
            Program.Exact(written, "v", "kind", "stage", "batchId", "eventsAttempted", "eventsWritten", "eventsCompleted", "bytesWritten");
            Program.Require(written.GetProperty("eventsAttempted").GetInt32() == OutputEventCount && written.GetProperty("eventsWritten").GetInt32() == OutputEventCount && written.GetProperty("eventsCompleted").GetInt32() == OutputEventCount && written.GetProperty("bytesWritten").GetInt64() == checked((long)OutputEventCount * started.GetProperty("nativeEventBytes").GetInt32()) && query.Alive, "output_high_native_batch_complete");
            values["outputBatchWritten"] = written; Mark("native-batch-written");
            if (scenario == "output-held-close")
            {
                Program.Require(readGate is not null && sentinel?.Pin?.Alive is true, "output_held_close_original_owners_required");
                await child.SendRawAsync(Command("close", closeId), token); Mark("valid-close-write-completed-while-paused");
                child.CloseRawInput(); Mark("caller-real-eof-while-paused");
                var nativeStop = await BatchStage("native-stop-observed");
                Program.Exact(nativeStop, "v", "kind", "stage", "batchId", "requestId", "executionId", "identity");
                Program.Require(Program.Text(nativeStop, "executionId") == executionId && nativeStop.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == query.Identity && Program.Text(nativeStop, "requestId").Length == 32, "output_held_close_correlated_native_stop");
                values["outputNativeStop"] = nativeStop; Mark("native-stop-observed"); await SettleHelper(1);
                await sentinel!.SendRawAsync(new { v = 1, kind = "ping", requestId = "sentinel-before-stdout-resume" }, token);
                await ((Frames)values["sentinelFrames"]!).MatchAsync(frame => Program.Text(frame, "kind") == "pong" && Program.Text(frame, "requestId") == "sentinel-before-stdout-resume", token);
                values["sentinelResponsiveBeforeStdoutResume"] = true; Mark("sentinel-responsive-before-resume");
                Program.Require(!Probe.Signaled(child.Original), "output_held_close_bridge_exited_before_resume_not_triggered");
                values["originalBridgeUnsignaledBeforeStdoutResume"] = true; Mark("original-bridge-unsignaled-immediately-before-resume");
                Program.Require(readGate!.ResumeOnce("scenario-after-helper-and-sentinel-join"), "output_resume_once"); Mark("original-stdout-resumed");
                return;
            }
            if (readGate is not null) { Program.Require(readGate.ResumeOnce("scenario-after-high-batch"), "output_resume_once"); Mark("original-stdout-resumed"); }
            await AllEvents();
            await child.SendRawAsync(Command("close", closeId), token); Mark("valid-close-after-all-events"); child.CloseRawInput(); Mark("caller-real-eof-after-all-events");
            await SettleHelper(1);
        }
        finally
        {
            // This runs before any caller joins a potentially held original
            // child/read task. Cleanup release cannot certify the stimulus.
            if (readGate is not null) values["stdoutGateCleanupReleasePerformed"] = readGate.ResumeOnce("failure-cleanup");
        }
    }
    private static async Task OrdinaryReadyAsync(Child child, string leaf, JsonElement ready, Dictionary<string, object?> values, CancellationToken token)
    {
        using var pipe = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(token);
        Probe.Check(Probe.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid), "ordinary_ready_actual_pipe_peer");
        Program.Require(Probe.GetProcessId(child.Pin!.Handle) == pid && child.Pin.Alive, "ordinary_ready_original_creation_pin_peer");
        var replies = new Frames();
        var capture = new RawCapture(pipe, bytes => replies.Add(ParseRawFrame(bytes)));
        var sent = new List<string>();
        var sequence = 1;
        foreach (var op in new[] { "claim", "inspect", "stop" })
        {
            var requestId = (sequence++).ToString("x32", CultureInfo.InvariantCulture);
            var request = new { v = 1, requestId, op, executionId = Program.Text(ready, "executionId") };
            var bytes = Program.Utf8.GetBytes(JsonSerializer.Serialize(request, Program.Json) + "\n"); sent.Add(Convert.ToBase64String(bytes));
            await pipe.WriteAsync(bytes, token); await pipe.FlushAsync(token);
            if (op != "stop") await replies.MatchAsync(frame => Program.Text(frame, "kind") == "response" && Program.Text(frame, "requestId") == requestId && Program.Text(frame, "op") == op, token);
        }
        child.CloseRawInput(); await child.JoinAsync(token); await capture.Completion.WaitAsync(token);
        Program.Require(capture.Eof && capture.Error is null, "ordinary_ready_native_pipe_real_eof");
        values["nativePipe"] = new { server = child.Pin.Identity, originalCreationPinVerified = true, capture = capture.Evidence(), sentFramesBase64 = sent.ToArray(), stopAckRequired = false };
    }
    private static async Task MatrixCommandsAsync(string scenario, Child child, JsonElement bound, Frames frames, TestHelperBarrier barrier, Dictionary<string, object?> values, CancellationToken token)
    {
        var executionId = Program.Text(bound, "executionId");
        const string inspectId = "00000000000000000000000000000001", closeId = "00000000000000000000000000000002";
        values["inspectRequestId"] = inspectId; values["closeRequestId"] = closeId;
        object Command(string op, string id) => new { v = 1, kind = "command", requestId = id, op, executionId };
        Task<JsonElement> Unknown() => frames.MatchAsync(frame => Program.Text(frame, "kind") == "unknown", token);
        async Task Inspect(string id)
        {
            await child.SendRawAsync(Command("inspect", id), token);
            await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" && frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == id, token);
        }
        if (scenario == "matrix-eof-after-bound") { child.CloseRawInput(); return; }
        if (scenario == "matrix-deadline")
        {
            await Unknown(); values["bridgeRetainedAtUnknown"] = child.Pin!.Alive; child.CloseRawInput(); return;
        }
        if (scenario is "matrix-stdout-extra" or "matrix-stdout-overflow" or "matrix-stderr-payload")
        {
            await Unknown(); child.CloseRawInput(); return;
        }
        if (scenario == "matrix-pending-close")
        {
            await child.SendRawAsync(Command("inspect", inspectId), token);
            await barrier.StageAsync("inspect-held", token);
            values["actualInspectHeldBeforeClose"] = true;
            await child.SendRawAsync(Command("close", closeId), token); child.CloseRawInput(); return;
        }
        if (scenario == "matrix-withheld-eof")
        {
            await Inspect(inspectId); await child.SendRawAsync(Command("close", closeId), token);
            await Unknown(); values["bridgeRetainedAtUnknown"] = child.Pin!.Alive; values["callerEofWithheldUntilUnknown"] = true;
            child.CloseRawInput(); return;
        }
        if (scenario.StartsWith("matrix-forbidden-", StringComparison.Ordinal))
        {
            await child.SendRawAsync(Command(scenario["matrix-forbidden-".Length..], inspectId), token);
            await Unknown(); child.CloseRawInput(); return;
        }
        if (scenario is "matrix-extra-field" or "matrix-duplicate-key" or "matrix-input-overflow")
        {
            var text = JsonSerializer.Serialize(Command("inspect", inspectId), Program.Json);
            text = scenario switch
            {
                "matrix-extra-field" => text[..^1] + ",\"extra\":true}",
                "matrix-duplicate-key" => text.Replace("\"v\":1", "\"v\":1,\"\\u0076\":1", StringComparison.Ordinal),
                _ => "{" + new string(' ', 1000) + text[1..],
            };
            if (scenario == "matrix-input-overflow")
            {
                var oversized = Program.Parse(text);
                Program.Exact(oversized, "v", "kind", "requestId", "op", "executionId");
                Program.Require(JsonElement.DeepEquals(oversized, Program.Element(Command("inspect", inspectId))), "oversized_caller_semantically_legal");
                values["inputOverflowSemanticallyLegal"] = true;
            }
            await child.SendRawBytesAsync(Program.Utf8.GetBytes(text + "\n"), token);
            await Unknown(); child.CloseRawInput(); return;
        }
        if (scenario == "matrix-duplicate-id")
        {
            await Inspect(inspectId); values["firstInspectObservedBeforeDuplicateIdSend"] = true; await child.SendRawAsync(Command("inspect", inspectId), token);
            await Unknown(); child.CloseRawInput(); return;
        }
        if (scenario == "matrix-duplicate-response-frame")
        {
            await Inspect(inspectId);
            await barrier.StageAsync("first-legal-response-sent", token);
            values["validInspectObservedBeforeDuplicateRelease"] = true;
            await barrier.ReleaseDuplicateAsync(token);
            await Unknown(); child.CloseRawInput(); return;
        }
        if (scenario == "matrix-session-input-overflow")
        {
            for (var sequence = 10; sequence < 30; sequence++)
            {
                var id = sequence.ToString("x32", CultureInfo.InvariantCulture);
                await child.SendRawAsync(Command("inspect", id), token);
                var response = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "unknown" || Program.Text(frame, "kind") == "state" && frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == id, token);
                if (Program.Text(response, "kind") == "unknown") { child.CloseRawInput(); return; }
            }
            throw new InvalidDataException("session_input_limit_not_observed");
        }
        if (scenario is "matrix-wrong-id" or "matrix-wrong-op" or "matrix-wrong-execution" or "matrix-wrong-role" or "matrix-duplicate-response" or "matrix-native-crlf" or "matrix-response-overflow")
        {
            await child.SendRawAsync(Command("inspect", inspectId), token); await Unknown(); child.CloseRawInput(); return;
        }
        if (scenario == "matrix-one-sided-eof")
        {
            var query = barrier.QueryPin ?? throw new InvalidDataException("one_sided_bound_query_missing");
            // Finish the successful inspect before releasing a cleanup fault.
            await Inspect(inspectId);
            values["oneSidedInspectObservedBeforeClose"] = true;
            await child.SendRawAsync(Command("close", closeId), token); child.CloseRawInput();
            var held = await barrier.StageAsync("stop-held", token);
            Program.Exact(held, "v", "kind", "stage", "identity");
            Program.Require(held.GetProperty("v").GetInt32() == 1 && held.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == query.Identity && query.Alive, "one_sided_actual_stop_held_identity");
            values["oneSidedStopHeldIdentity"] = held.GetProperty("identity").Clone();
            values["oneSidedCallerEofBeforeRelease"] = true;
            await barrier.ReleaseStdoutEofAsync(token);
            var closed = await barrier.StageAsync("actual-stdout-closed", token);
            Program.Exact(closed, "v", "kind", "stage", "identity", "stderrHandleKeptOpen");
            Program.Require(closed.GetProperty("v").GetInt32() == 1 && closed.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == query.Identity && closed.GetProperty("stderrHandleKeptOpen").GetBoolean() && query.Alive, "one_sided_actual_stdout_closed_identity");
            values["oneSidedStdoutClosedIdentity"] = closed.GetProperty("identity").Clone();
            values["oneSidedStageOrderProved"] = true;
            await Unknown(); return;
        }
        await Inspect(inspectId);
        await child.SendRawAsync(Command("close", closeId), token); child.CloseRawInput();
    }
    internal static async Task<int> RunAsync(string bridge, string ordinary, string fault, string directory, long deadlineTick, int cleanupMs)
    {
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        var commands = new Frames();
        var inputTask = Task.Run(async () =>
        {
            try
            {
                using var input = new StreamReader(Console.OpenStandardInput(), Program.Utf8, false, leaveOpen: true);
                while (await Program.ReadLineAsync(input, CancellationToken.None) is { } line) commands.Add(Program.Parse(line));
                commands.End();
            }
            catch (Exception error) { commands.End(error); throw; }
        });
        Program.Write(new { kind = "host-ready", identity = self.Identity, nonInherited = self.NonInherited, sameSid = self.SameSid, actorLaunches = 0 });
        using var execution = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, deadlineTick - Environment.TickCount64)));
        string? scenario = null;
        object? setupFailure = null, failure = null;
        Child? child = null;
        Child? sentinel = null;
        TestHelperBarrier? helperBarrier = null;
        RawReadGate? stdoutGate = null;
        string? transcriptPath = null;
        var values = new Dictionary<string, object?>();
        var cleanupFailures = new List<object>();
        string? recordsRoot = null, installationRoot = null;
        string[]? beforeRecords = null, beforeInstallation = null;
        var frames = new Frames();
        var boundSeen = false;
        var bridgeObservations = new List<(string Kind, long ObservedTick)>();
        var bridgeObservationGate = new object();
        try
        {
            var first = await commands.MatchAsync(value => value.TryGetProperty("scenario", out _), execution.Token);
            Program.Exact(first, "scenario"); scenario = Program.Text(first, "scenario");
            if (scenario is "execution-prepare" or "execution-permit-close" or "execution-permit-eof" or
                "execution-permit-replay" or "execution-natural-close-id" or "execution-stop-wire" || scenario.StartsWith("execution-node-", StringComparison.Ordinal))
                return await ExecutionBridgeHarness.RunAsync(bridge, ordinary, fault, directory, deadlineTick, cleanupMs, scenario, commands, inputTask);
            Program.Require(scenario is "guard-health" or "ordinary" or "ordinary-ready" || Matrix(scenario), "bridge_fixture_scenario");
            if (OutputScenario(scenario)) OutputShapeBudgets(values, scenario, deadlineTick, cleanupMs);
            Program.Require(new[] { bridge, ordinary, fault }.All(path => Path.IsPathFullyQualified(path) && File.Exists(path) && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)), "bridge_fixed_artifacts_required");
            recordsRoot = Path.Combine(directory, "records"); installationRoot = Path.Combine(directory, "installation");
            Probe.CreateDirectory(recordsRoot); Probe.CreateDirectory(installationRoot);
            beforeRecords = Inventory(recordsRoot); beforeInstallation = Inventory(installationRoot);
            Program.Write(new { kind = "metadata", value = new { scenario, bridgeLaunches = 0 } });
            var release = await commands.MatchAsync(value => value.TryGetProperty("continue", out _), execution.Token);
            Program.Exact(release, "continue"); Program.Require(release.GetProperty("continue").GetBoolean(), "bridge_fixture_exact_release");
        }
        catch (Exception error) { setupFailure = Program.Error(error); }
        if (setupFailure is null)
        {
            try
            {
                if (scenario is "guard-health" or "ordinary-ready")
                {
                    var args = new[] { "--pipe", Program.Leaf("zeb-control-"), "--controller-pid", self.Identity.Pid.ToString(CultureInfo.InvariantCulture), "--records-root", recordsRoot!, "--installation-root", installationRoot!, "--expected-manifest-sha256", new string('a', 64) };
                    child = new Child(scenario == "guard-health" ? fault : ordinary, directory, args);
                    if (scenario == "guard-health") child.SetTestEnvironment("ZEB_CONTROL_BRIDGE_FIXTURE_MODE", "guard-health");
                    values["bridgeLaunches"] = 0;
                    values["helperEvidence"] = scenario == "guard-health" ? "direct-original-test-fixture-creation-pin" : "direct-original-ordinary-creation-pin";
                    values["actualHealthBootstrapArguments"] = args;
                    values["ordinaryLeaf"] = args[1];
                }
                else
                {
                    var environment = HelperEnvironment();
                    if (Matrix(scenario!))
                    {
                        helperBarrier = new TestHelperBarrier(); transcriptPath = Path.Combine(directory, "controlled-helper-transcript.jsonl");
                        environment.Add("ZEB_CONTROL_BRIDGE_FIXTURE_MODE", FaultMode(scenario!));
                        environment.Add("ZEB_CONTROL_BRIDGE_FIXTURE_TRANSCRIPT", transcriptPath);
                        environment.Add("ZEB_CONTROL_BRIDGE_FIXTURE_BARRIER", helperBarrier.Leaf);
                        if (OutputScenario(scenario!)) environment.Add("ZEB_CONTROL_BRIDGE_FIXTURE_TRANSCRIPT_LIMIT", OutputTranscriptBytes.ToString(CultureInfo.InvariantCulture));
                    }
                    var config = new
                    {
                        v = 1, helperPath = Matrix(scenario!) ? fault : ordinary, recordsRoot, installationRoot,
                        expectedManifestSha256 = new string('a', 64), environment,
                        limits = new
                        {
                            maxRequestFrameBytes = scenario is "matrix-input-overflow" or "matrix-session-input-overflow" ? 512 : 65536, maxResponseFrameBytes = OutputScenario(scenario!) ? OutputResponseBytes : 65536,
                            maxHelperStderrBytes = 8192, maxSessionInputBytes = scenario == "matrix-session-input-overflow" ? 1024 : 262144,
                            maxSessionOutputBytes = scenario == "output-session-low" ? checked(3 * OutputResponseBytes) : OutputScenario(scenario!) ? OutputHighBytes : 1048576,
                            maxQueuedOutputBytes = scenario == "output-queue-low" ? checked(2 * OutputResponseBytes) : OutputScenario(scenario!) ? OutputHighBytes : 262144,
                            maxJsonDepth = 16, startupTimeoutMs = 8000, requestTimeoutMs = 5000,
                            sessionTimeoutMs = OutputScenario(scenario!) ? checked(OutputExecutionMs + OutputCleanupMs + 1) : scenario == "matrix-deadline" ? 3000 : 45000, cleanupTimeoutMs = Matrix(scenario!) ? 1000 : 5000,
                        },
                    };
                    child = new Child(bridge, directory, "--control-bridge", JsonSerializer.Serialize(config, Program.Json));
                    values["bridgeLaunches"] = 1;
                    values["helperEvidence"] = "trusted-bridge-statement-plus-exact-job-query";
                    values["helperBootstrapSource"] = "production-constructive-ten-argument-allowlist-not-independent-command-line-observation";
                    values["helperEnvironmentKeys"] = config.environment.Keys.Order(StringComparer.Ordinal).ToArray();
                    values["configuredSessionTimeoutMs"] = config.limits.sessionTimeoutMs;
                }
                if (scenario is "matrix-held-live" or "matrix-one-sided-eof" or "output-held-close")
                {
                    var sentinelFrames = new Frames();
                    sentinel = new Child(fault, directory, "--pipe", Program.Leaf("zeb-control-"), "--controller-pid", self.Identity.Pid.ToString(CultureInfo.InvariantCulture), "--records-root", recordsRoot!, "--installation-root", installationRoot!, "--expected-manifest-sha256", new string('a', 64));
                    sentinel.SetTestEnvironment("ZEB_CONTROL_BRIDGE_FIXTURE_MODE", "sentinel");
                    sentinel.StartRaw(bytes => sentinelFrames.Add(ParseRawFrame(bytes)));
                    await RegisterAsync(sentinel.Pin!.Identity, "direct-sentinel-created-in-host", commands, execution.Token);
                    await sentinelFrames.MatchAsync(frame => Program.Text(frame, "kind") == "ready", execution.Token);
                    values["sentinelReadyBeforeBridgeStart"] = sentinel.Pin.Alive;
                    values["sentinelFrames"] = sentinelFrames;
                }
                // child is retained before Start, and the original self is
                // already inside the outer Job. Descendants inherit it at birth.
                values["bridgeStartAttemptTick"] = Environment.TickCount64;
                if (OutputScenario(scenario!))
                {
                    var boundary = checked((long)values["bridgeStartAttemptTick"]! + (int)values["configuredSessionTimeoutMs"]!);
                    Program.Require(boundary > checked(deadlineTick + cleanupMs), "output_native_session_outside_complete_host_window");
                    values["outputNativeSessionBoundaryTick"] = boundary;
                    if (scenario is "output-queue-high" or "output-queue-low" or "output-held-close") stdoutGate = new RawReadGate("00000000000000000000000000000001");
                }
                child.StartRaw(bytes =>
                {
                    var frame = scenario == "ordinary-ready" ? ParseRawReady(bytes) : ParseRawFrame(bytes);
                    lock (bridgeObservationGate) bridgeObservations.Add((Program.Text(frame, "kind"), Environment.TickCount64));
                    frames.Add(frame);
                    stdoutGate?.Observe(frame);
                }, stdoutGate, OutputScenario(scenario!) ? OutputHighBytes : 262144);
                _ = child.RawOutput!.Completion.ContinueWith(_ => frames.End(child.RawOutput.Error is null ? null : new InvalidDataException(child.RawOutput.Error)), TaskScheduler.Default);
                await RegisterAsync(child.Pin!.Identity, scenario == "guard-health" ? "direct-health-helper-created-in-host" : scenario == "ordinary-ready" ? "direct-ordinary-created-in-host" : "original-bridge-created-in-host", commands, execution.Token);
                if (helperBarrier is not null)
                {
                    await helperBarrier.BindAsync(commands, execution.Token);
                    if (scenario == "matrix-eof-before-ready") { child.CloseRawInput(); values["callerEofBeforeReadyRelease"] = true; }
                    await helperBarrier.ReleaseAsync(execution.Token);
                }
                var first = await frames.AtAsync(0, execution.Token);
                values["firstFrame"] = first;
                if (Matrix(scenario!) && !PreboundFault(scenario!)) Program.Require(Program.Text(first, "kind") == "bound", "post_bound_fault_requires_actual_bound");
                if (scenario == "guard-health")
                {
                    Program.Exact(first, "v", "kind", "executionId");
                    Program.Require(first.GetProperty("v").GetInt32() == 1 && Program.Text(first, "kind") == "ready", "health_original_ready");
                }
                else if (scenario == "ordinary-ready") await OrdinaryReadyAsync(child, (string)values["ordinaryLeaf"]!, first, values, execution.Token);
                else if (Program.Text(first, "kind") == "bound")
                {
                    boundSeen = true;
                    Program.Exact(first, "v", "kind", "executionId", "bridge", "helper", "state");
                    Program.Require(first.GetProperty("bridge").Deserialize<ProcessFact>(Program.Json) == child.Pin.Identity, "bridge_bound_matches_original_creation_pin");
                    var helper = first.GetProperty("helper").Deserialize<ProcessFact>(Program.Json)!;
                    Program.Require(helper.Pid > 0 && helper.CreationFileTime.Length > 0 && helper.CreationFileTime[0] != '0' && ulong.TryParse(helper.CreationFileTime, NumberStyles.None, CultureInfo.InvariantCulture, out var creation) && creation > 0 && creation.ToString(CultureInfo.InvariantCulture) == helper.CreationFileTime, "bridge_canonical_helper_identity");
                    if (helperBarrier is null) await RegisterAsync(helper, "trusted-bridge-helper-query", commands, execution.Token);
                    else Program.Require(helper == helperBarrier.QueryPin!.Identity, "bridge_bound_matches_test_barrier_identity_query");
                    if (helperBarrier is not null && OutputScenario(scenario!)) await OutputCommandsAsync(scenario!, child, first, frames, helperBarrier, stdoutGate, sentinel, values, execution.Token);
                    else if (helperBarrier is not null) await MatrixCommandsAsync(scenario!, child, first, frames, helperBarrier, values, execution.Token);
                    else
                    {
                    var executionId = Program.Text(first, "executionId");
                    const string inspectId = "00000000000000000000000000000001", closeId = "00000000000000000000000000000002";
                    values["inspectRequestId"] = inspectId; values["closeRequestId"] = closeId;
                    await child.SendRawAsync(new { v = 1, kind = "command", requestId = inspectId, op = "inspect", executionId }, execution.Token);
                    await frames.MatchAsync(frame => Program.Text(frame, "kind") == "state" && frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == inspectId, execution.Token);
                    await child.SendRawAsync(new { v = 1, kind = "command", requestId = closeId, op = "close", executionId }, execution.Token);
                    }
                }
                else
                {
                    // A legal Unknown-only scaffold is data, not fixture
                    // failure. The test asserts bound after healthy cleanup.
                    Program.Exact(first, "v", "kind", "requestId", "executionId");
                    Program.Require(first.GetProperty("v").GetInt32() == 1 && Program.Text(first, "kind") == "unknown" && first.GetProperty("requestId").ValueKind == JsonValueKind.Null && (helperBarrier is not null || first.GetProperty("executionId").ValueKind == JsonValueKind.Null), "scaffold_or_fault_legal_unknown_required");
                }
                child.CloseRawInput();
                await child.JoinAsync(execution.Token);
                if (boundSeen && !OutputLow(scenario!)) await frames.MatchAsync(frame => Program.Text(frame, "kind") == "closed", execution.Token);
                if (helperBarrier is not null) await helperBarrier.JoinAsync(execution.Token);
                if (sentinel is not null)
                {
                    Program.Require(sentinel.Pin!.Alive, "unrelated_sentinel_not_alive_after_bridge_cleanup");
                    if (scenario != "output-held-close")
                    {
                        await sentinel.SendRawAsync(new { v = 1, kind = "ping", requestId = "sentinel-after-cleanup" }, execution.Token);
                        var sentinelFrames = (Frames)values["sentinelFrames"]!;
                        await sentinelFrames.MatchAsync(frame => Program.Text(frame, "kind") == "pong" && Program.Text(frame, "requestId") == "sentinel-after-cleanup", execution.Token);
                        values["sentinelResponsiveAfterBridgeCleanup"] = true;
                    }
                    else values["sentinelAliveAfterBridgeCleanup"] = true;
                    values.Remove("sentinelFrames");
                    sentinel.CloseRawInput(); await sentinel.JoinAsync(execution.Token);
                }
            }
            catch (Exception error) { failure = Program.Error(error); }
        }
        var cleanupAt = Math.Min(Environment.TickCount64 + cleanupMs, deadlineTick + cleanupMs);
        Program.Write(new { kind = "host-cleanup-start", deadlineTick = cleanupAt });
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupAt - Environment.TickCount64)));
        if (stdoutGate is not null)
        {
            values["stdoutGateDefensiveCleanupReleasePerformed"] = stdoutGate.ResumeOnce("failure-cleanup-before-original-join");
            if (child?.Started is not true) stdoutGate.Finish();
        }
        if (child?.Started is true)
        {
            try { child.CloseRawInput(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            if ((failure is not null || setupFailure is not null) && !child.OriginalJoined)
                try { child.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            try { await child.JoinAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        }
        if (sentinel?.Started is true)
        {
            try { sentinel.CloseRawInput(); await sentinel.JoinAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        }
        if (helperBarrier is not null) try { await helperBarrier.JoinAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        if (stdoutGate is not null)
        {
            try { await stdoutGate.Completion.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            values["stdoutReadGate"] = stdoutGate.Evidence();
        }
        // The outer closes its original host stdin on host-cleanup-start. This
        // join observes that actual EOF; cancellation never supplies a fake one.
        try { await inputTask.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        values["child"] = child?.RawEvidence();
        lock (bridgeObservationGate) values["bridgeFrameObservations"] = bridgeObservations.Select(value => new { kind = value.Kind, observedTick = value.ObservedTick }).ToArray();
        values.Remove("sentinelFrames");
        if (sentinel is not null) values["sentinel"] = sentinel.RawEvidence();
        if (helperBarrier is not null) values["testHelperBarrier"] = helperBarrier.Evidence();
        if (transcriptPath is not null && File.Exists(transcriptPath))
        {
            var bytes = File.ReadAllBytes(transcriptPath); Program.Require(bytes.Length <= (OutputScenario(scenario!) ? OutputTranscriptBytes : 1048576), "controlled_transcript_limit");
            values["helperTranscriptRawBase64"] = Convert.ToBase64String(bytes);
            values["helperTranscript"] = Program.Utf8.GetString(bytes).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(Program.Parse).ToArray();
        }
        values["beforeRecords"] = beforeRecords; values["beforeInstallation"] = beforeInstallation;
        values["afterRecords"] = recordsRoot is null ? null : Inventory(recordsRoot);
        values["afterInstallation"] = installationRoot is null ? null : Inventory(installationRoot);
        values["recordsUnchanged"] = Program.Equal(values["beforeRecords"], values["afterRecords"]);
        values["installationUnchanged"] = Program.Equal(values["beforeInstallation"], values["afterInstallation"]);
        values["prepareOrAuthorizeSent"] = false;
        values["engineLaunchedByFixture"] = false;
        var joined = child?.OriginalJoined is true && child.RawOutput?.Eof is true && child.RawError?.Eof is true && (sentinel is null || sentinel.OriginalJoined && sentinel.RawOutput?.Eof is true && sentinel.RawError?.Eof is true) && (helperBarrier is null || helperBarrier.ActualEof && helperBarrier.QueryPin?.Joined is true);
        Program.Write(new { kind = "receipt", value = new { scenario, setupFailure, failure, values, cleanup = new { failures = cleanupFailures, originalRegistry = true, allObservedJoined = joined } } });
        // The exact Job remains the outer fallback owner on any failed join;
        // disposal here releases only this host's retained direct-child handles.
        child?.Dispose(); sentinel?.Dispose(); helperBarrier?.Dispose();
        return cleanupFailures.Count == 0 ? 0 : 1;
    }
}

internal sealed class Rpc : IDisposable
{
    internal Child Child { get; }
    internal JsonElement? ExitReply { get; private set; }
    private readonly Frames frames = new();
    private readonly SemaphoreSlim writes = new(1);
    private int sequence;
    internal Rpc(string executable, string directory, params string[] args) => Child = new Child(executable, directory, args);
    internal void Start()
    {
        Child.Start(line => frames.Add(Program.Parse(line)));
        _ = Child.Output!.Completion.ContinueWith(_ => frames.End(Child.Output.Error is null ? null : new InvalidDataException(Child.Output.Error)), TaskScheduler.Default);
    }
    internal Task<JsonElement> ReadyAsync(CancellationToken token) => frames.MatchAsync(frame => Program.Text(frame, "kind") == "actor-ready", token);
    internal async Task<JsonElement> CallAsync(string op, object? value, CancellationToken token)
    {
        var id = Interlocked.Increment(ref sequence);
        await writes.WaitAsync(token);
        try { await Child.SendAsync(new { id, op, value }, token); } finally { writes.Release(); }
        var reply = await frames.MatchAsync(frame => Program.Text(frame, "kind") == "reply" && frame.GetProperty("id").GetInt32() == id, token);
        Program.Require(reply.GetProperty("ok").GetBoolean(), "private_actor_failed:" + reply.GetRawText());
        return reply.GetProperty("value").Clone();
    }
    internal async Task ExitUntilSignaledAsync(CancellationToken token) { ExitReply = await CallAsync("exit", null, token); Child.Input.Close(); await Child.Pin!.WaitAsync(token); }
    internal async Task ExitAsync(CancellationToken token) { if (Child.Pin?.Alive != true) { await Child.JoinAsync(token); return; } ExitReply = await CallAsync("exit", null, token); Child.Input.Close(); await Child.JoinAsync(token); }
    public void Dispose() { Child.Dispose(); writes.Dispose(); }
}

internal sealed class PipeClient : IDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly ProcessPin server;
    private readonly string executionId;
    private readonly Frames frames = new();
    private readonly List<JsonElement> sent = [];
    private readonly List<string> raw = [];
    private readonly SemaphoreSlim writes = new(1);
    private readonly Task reader;
    private bool localClose;
    private bool eof;
    private string? readerError;
    internal object ConnectionEvidence { get; }
    private PipeClient(NamedPipeClientStream pipe, ProcessPin server, string executionId)
    {
        this.pipe = pipe; this.server = server; this.executionId = executionId;
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        ConnectionEvidence = new { server = server.Identity, client = self.Identity, serverSameSid = server.SameSid, serverNonInherited = server.NonInherited, pipeNonInherited = Probe.NonInherited(pipe.SafePipeHandle) };
        reader = ReadAsync();
    }
    internal static async Task<PipeClient> OpenAsync(string leaf, ProcessFact expected, string executionId, CancellationToken token)
    {
        var pipe = new NamedPipeClientStream(".", leaf, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
        ProcessPin? server = null;
        try
        {
            await pipe.ConnectAsync(token);
            Probe.Check(Probe.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid), "pipe_actual_server");
            server = ProcessPin.Open(pid);
            Program.Require(server.Identity == expected && server.Alive, "pipe_server_original_identity");
            return new(pipe, server, executionId);
        }
        catch { server?.Dispose(); pipe.Dispose(); throw; }
    }
    private async Task ReadAsync()
    {
        try
        {
            using var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true);
            while (await Program.ReadLineAsync(input, CancellationToken.None) is { } line)
            {
                lock (raw) raw.Add(line);
                var frame = Program.Parse(line);
                var kind = Program.Text(frame, "kind");
                if (kind == "response") Program.Exact(frame, "v", "kind", "requestId", "op", "executionId", "role", "state");
                else if (kind == "error")
                {
                    if (frame.TryGetProperty("prepareDiagnostic", out JsonElement diagnostic))
                    {
                        Program.Exact(frame, "v", "kind", "requestId", "code", "prepareDiagnostic");
                        _ = PrepareDiagnostic.Parse(diagnostic);
                    }
                    else Program.Exact(frame, "v", "kind", "requestId", "code");
                }
                else if (kind == "event") Program.Exact(frame, "v", "kind", "event", "executionId", "state");
                else throw new InvalidDataException("pipe_unknown_kind");
                Program.Require(frame.GetProperty("v").GetInt32() == 1, "pipe_version");
                if (kind is "response" or "event") Program.Require(Program.Text(frame, "executionId") == executionId, "pipe_execution_identity");
                frames.Add(frame);
            }
            eof = true;
        }
        catch (Exception error) when (localClose && error is IOException or ObjectDisposedException or OperationCanceledException) { }
        catch (Exception error) { readerError = error.GetType().Name + ":" + error.Message; frames.End(error); }
        finally { frames.End(); }
    }
    internal async Task SendAsync(JsonElement request, CancellationToken token)
    {
        lock (sent) sent.Add(request.Clone());
        await writes.WaitAsync(token);
        try { await Program.SendAsync(pipe, request, token); } finally { writes.Release(); }
    }
    internal async Task WriteRawAsync(string text, CancellationToken token)
    {
        await writes.WaitAsync(token);
        try { await pipe.WriteAsync(Program.Utf8.GetBytes(text), token); await pipe.FlushAsync(token); } finally { writes.Release(); }
    }
    internal async Task<JsonElement> ResponseAsync(string requestId, bool acceptNull, CancellationToken token)
    {
        var reply = await frames.MatchAsync(frame => frame.TryGetProperty("requestId", out var id) && (id.ValueKind == JsonValueKind.String && id.GetString() == requestId || acceptNull && id.ValueKind == JsonValueKind.Null && Program.Text(frame, "kind") == "error"), token);
        if (Program.Text(reply, "kind") == "response")
        {
            JsonElement original;
            lock (sent) original = sent.Single(request => Program.Text(request, "requestId") == requestId);
            Program.Require(Program.Text(reply, "op") == Program.Text(original, "op"), "pipe_reply_original_request");
        }
        return reply;
    }
    internal async Task<JsonElement> ExchangeAsync(JsonElement request, CancellationToken token) { await SendAsync(request, token); return await ResponseAsync(Program.Text(request, "requestId"), false, token); }
    internal Task<JsonElement> EventAsync(string property, string value, CancellationToken token) => frames.MatchAsync(frame => Program.Text(frame, "kind") == "event" && frame.GetProperty("state").TryGetProperty(property, out var actual) && actual.ValueKind == JsonValueKind.String && actual.GetString() == value, token);
    internal Task<JsonElement> RuntimeObservationResultAsync(CancellationToken token) => frames.MatchAsync(frame =>
        Program.Text(frame, "kind") == "event" && frame.GetProperty("state").TryGetProperty("runtimeObservation", out var observation) &&
        observation.ValueKind == JsonValueKind.Object && observation.GetProperty("gpu").GetProperty("state").GetString() is "observed" or "unknown", token);
    internal object Snapshot() { lock (raw) lock (sent) return new { connection = ConnectionEvidence, actualEof = eof, localClose, readerError, rawFrames = raw.ToArray(), frames = frames.Snapshot, sent = sent.ToArray() }; }
    internal string DuplicateTo(ProcessPin host) => Probe.DuplicateTo(pipe.SafePipeHandle.DangerousGetHandle(), host.Handle);
    internal async Task<object> WaitClosedAsync(CancellationToken token) { await reader.WaitAsync(token); return Snapshot(); }
    internal async Task<object> CloseAsync(CancellationToken token) { localClose = true; pipe.Dispose(); await reader.WaitAsync(token); Program.Require(readerError is null, "production_pipe_reader_failed:" + readerError); return Snapshot(); }
    public void Dispose() { localClose = true; pipe.Dispose(); server.Dispose(); writes.Dispose(); }
}

internal static class Agent
{
    internal static async Task<int> RunAsync(uint hostPid, string directory, long deadlineTick)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, deadlineTick - Environment.TickCount64)));
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        using var host = ProcessPin.Open(hostPid, 0x0040);
        var pipes = new Dictionary<string, PipeClient>(StringComparer.Ordinal);
        var helpers = new List<Process>();
        Program.Write(new { kind = "actor-ready", identity = self.Identity, nonInherited = self.NonInherited, sameSid = self.SameSid });
        try
        {
            using var input = new StreamReader(Console.OpenStandardInput(), Program.Utf8, false, leaveOpen: true);
            while (await Program.ReadLineAsync(input, deadline.Token) is { } line)
            {
                var command = Program.Parse(line);
                var id = command.GetProperty("id").GetInt32();
                var value = command.GetProperty("value");
                try
                {
                    object? result;
                    switch (Program.Text(command, "op"))
                    {
                        case "launch":
                            var start = new ProcessStartInfo(Program.Text(value, "executable")) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
                            foreach (var arg in value.GetProperty("args").EnumerateArray()) start.ArgumentList.Add(arg.GetString()!);
                            if (value.TryGetProperty("bridge", out var bridge) && bridge.ValueKind != JsonValueKind.Null) start.Environment["ZEB_NATIVE_SESSION_TEST_BRIDGE"] = bridge.GetRawText();
                            else start.Environment.Remove("ZEB_NATIVE_SESSION_TEST_BRIDGE");
                            var child = new Process { StartInfo = start };
                            helpers.Add(child);
                            Program.Require(child.Start(), "agent_launch_original_helper");
                            using (var original = ProcessPin.Duplicate(child.SafeHandle))
                            {
                                result = new { identity = original.Identity, processHandle = Probe.DuplicateTo(child.SafeHandle.DangerousGetHandle(), host.Handle), stdoutHandle = Probe.DuplicateTo(Probe.StreamHandle(child.StandardOutput.BaseStream), host.Handle), stderrHandle = Probe.DuplicateTo(Probe.StreamHandle(child.StandardError.BaseStream), host.Handle), controllerIdentity = self.Identity, originalRetained = true, sameSid = original.SameSid, nonInherited = original.NonInherited };
                            }
                            child.StandardInput.Close(); child.StandardOutput.Dispose(); child.StandardError.Dispose();
                            break;
                        case "open":
                            var key = Program.Text(value, "key");
                            var client = await PipeClient.OpenAsync(Program.Text(value, "leaf"), value.GetProperty("expected").Deserialize<ProcessFact>(Program.Json)!, Program.Text(value, "executionId"), deadline.Token);
                            if (!pipes.TryAdd(key, client)) { client.Dispose(); throw new InvalidDataException("agent_duplicate_pipe_key"); }
                            result = client.ConnectionEvidence;
                            break;
                        case "exchange": result = await pipes[Program.Text(value, "key")].ExchangeAsync(value.GetProperty("request"), deadline.Token); break;
                        case "send": await pipes[Program.Text(value, "key")].SendAsync(value.GetProperty("request"), deadline.Token); result = new { sent = true }; break;
                        case "response": result = await pipes[Program.Text(value, "key")].ResponseAsync(Program.Text(value, "requestId"), value.TryGetProperty("acceptNull", out var accept) && accept.GetBoolean(), deadline.Token); break;
                        case "event": result = await pipes[Program.Text(value, "key")].EventAsync(Program.Text(value, "property"), Program.Text(value, "match"), deadline.Token); break;
                        case "observation-result": result = await pipes[Program.Text(value, "key")].RuntimeObservationResultAsync(deadline.Token); break;
                        case "write-raw": await pipes[Program.Text(value, "key")].WriteRawAsync(Program.Text(value, "text"), deadline.Token); result = new { written = true }; break;
                        case "snapshot": result = pipes[Program.Text(value, "key")].Snapshot(); break;
                        case "wait-closed": result = await pipes[Program.Text(value, "key")].WaitClosedAsync(deadline.Token); break;
                        case "retain-pipe": result = new { handle = pipes[Program.Text(value, "key")].DuplicateTo(host) }; break;
                        case "close": result = await pipes[Program.Text(value, "key")].CloseAsync(deadline.Token); break;
                        case "exit":
                            foreach (var pipe in pipes.Values) await pipe.CloseAsync(deadline.Token);
                            Program.Write(new { kind = "reply", id, ok = true, value = new { code = 0, pipes = pipes.ToDictionary(item => item.Key, item => item.Value.Snapshot()) } });
                            return 0;
                        default: throw new InvalidDataException("agent_private_op");
                    }
                    Program.Write(new { kind = "reply", id, ok = true, value = result });
                }
                catch (Exception error) { Program.Write(new { kind = "reply", id, ok = false, value = Program.Error(error) }); }
            }
            return 0;
        }
        finally { foreach (var pipe in pipes.Values) { await pipe.CloseAsync(deadline.Token); pipe.Dispose(); } foreach (var helper in helpers) helper.Dispose(); }
    }
}

internal sealed class Subject : IDisposable
{
    internal ProcessPin Pin { get; }
    internal Capture Output { get; }
    internal Capture Error { get; }
    internal string? ExecutionId { get; private set; }
    internal bool Forced { get; private set; }
    internal JsonElement? Ready { get; private set; }
    internal Subject(JsonElement handoff)
    {
        var expected = handoff.GetProperty("identity").Deserialize<ProcessFact>(Program.Json)!;
        Pin = ProcessPin.Adopt(new SafeFileHandle(Probe.Pointer(Program.Text(handoff, "processHandle")), true), expected);
        Output = new Capture(new StreamReader(new FileStream(new SafeFileHandle(Probe.Pointer(Program.Text(handoff, "stdoutHandle")), true), FileAccess.Read), Program.Utf8, false));
        Error = new Capture(new StreamReader(new FileStream(new SafeFileHandle(Probe.Pointer(Program.Text(handoff, "stderrHandle")), true), FileAccess.Read), Program.Utf8, false));
    }
    internal async Task StartupAsync(CancellationToken token)
    {
        var first = await Output.First.Task.WaitAsync(token);
        Program.Require(first is not null, "actual_program_no_ready");
        var ready = Program.Parse(first!);
        Program.Exact(ready, "v", "kind", "executionId");
        Program.Require(ready.GetProperty("v").GetInt32() == 1 && Program.Text(ready, "kind") == "ready", "actual_program_ready_shape");
        ExecutionId = Program.Text(ready, "executionId");
        Program.Require(ExecutionId.Length == 32 && ExecutionId.All(value => value is >= '0' and <= '9' or >= 'a' and <= 'f'), "actual_program_execution_id");
        Ready = ready;
    }
    internal async Task JoinAsync(CancellationToken token) { await Pin.WaitAsync(token); await Task.WhenAll(Output.Completion, Error.Completion).WaitAsync(token); Program.Require(Output.Eof && Error.Eof && Output.Error is null && Error.Error is null, "subject_actual_close_dual_eof"); }
    internal void Terminate() { if (Pin.Alive) { Forced = true; Pin.Terminate(); } }
    internal object Evidence() => new { identity = Pin.Identity, started = true, originalRetained = true, originalJoined = Pin.Joined, alive = Pin.Alive, exitCode = Pin.ExitCode, nonInherited = Pin.NonInherited, sameSid = Pin.SameSid, stdoutEof = Output.Eof, stderrEof = Error.Eof, stdoutError = Output.Error, stderrError = Error.Error, stdout = Output.Lines, stderr = Error.Lines, ready = Ready, forced = Forced };
    public void Dispose() => Pin.Dispose();
}

internal sealed class Bundle
{
    internal const string ModelName = "upscayl-standard-4x";
    internal string Root { get; }
    internal string Binary => Path.Combine(Root, "bin", "upscayl-bin.exe");
    internal string ModelDirectory => Path.Combine(Root, "models", "fixture-model");
    internal string ModelBin => Path.Combine(ModelDirectory, ModelName + ".bin");
    internal string ModelParam => Path.Combine(ModelDirectory, ModelName + ".param");
    internal string Manifest => Path.Combine(Root, "installation-manifest.json");
    internal string ManifestSha256 { get; }
    internal EngineSelection Selection { get; }
    internal string[] DeclaredFiles { get; }
    internal object[] PublishFiles { get; }
    internal Bundle(string root)
    {
        Root = root;
        var sourceRoot = AppContext.BaseDirectory;
        // The fixed publish artifact, not a guessed CLR dependency subset, is
        // the installation closure. No scan of the repository is performed.
        var sourceFiles = Directory.GetFiles(sourceRoot, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal).ToArray();
        Program.Require(sourceFiles.Length != 0 && sourceFiles.All(path => (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0), "fixture_publish_plain_files");
        var relative = sourceFiles.Select(path => Path.GetRelativePath(sourceRoot, path).Replace('\\', '/')).ToArray();
        Program.Require(relative.Distinct(StringComparer.OrdinalIgnoreCase).Count() == relative.Length, "fixture_publish_case_collision");
        foreach (var directory in new[] { Root, Path.Combine(Root, "bin"), Path.Combine(Root, "models"), ModelDirectory }) Probe.CreateDirectory(directory);
        var entries = new List<object>();
        var fileEvidence = new List<object>();
        var copied = new List<string>();
        foreach (var source in sourceFiles)
        {
            var leaf = Path.GetRelativePath(sourceRoot, source);
            var destination = Path.Combine(Root, "bin", leaf);
            var parent = Path.GetDirectoryName(destination)!;
            var missing = new Stack<string>();
            for (var next = parent; !Directory.Exists(next); next = Path.GetDirectoryName(next)!) missing.Push(next);
            while (missing.TryPop(out var directory)) Probe.CreateDirectory(directory);
            var bytes = File.ReadAllBytes(source);
            Probe.CreateFile(destination, bytes);
            copied.Add(destination);
            entries.Add(Entry("bin/" + leaf.Replace('\\', '/'), bytes));
            using var handle = Probe.OpenFile(destination);
            Probe.RequireProtected(handle);
            fileEvidence.Add(new { leaf = "bin/" + leaf.Replace('\\', '/'), length = bytes.LongLength.ToString(CultureInfo.InvariantCulture), sha256 = Program.Hash(bytes), sameBytes = bytes.AsSpan().SequenceEqual(Probe.Bytes(handle)), sameSha256 = Program.Hash(bytes) == Probe.FileHash(handle), protectedAcl = true });
        }
        var apphost = File.ReadAllBytes(Program.Self);
        Probe.CreateFile(Binary, apphost);
        copied.Add(Binary);
        entries.Add(Entry("bin/upscayl-bin.exe", apphost));
        fileEvidence.Add(new { leaf = "bin/upscayl-bin.exe", length = apphost.LongLength.ToString(CultureInfo.InvariantCulture), sha256 = Program.Hash(apphost), sameBytes = apphost.AsSpan().SequenceEqual(File.ReadAllBytes(Binary)), sameSha256 = Program.Hash(apphost) == Program.Hash(File.ReadAllBytes(Binary)), protectedAcl = true });
        var modelBytes = new byte[] { 0, 0x17, 0xff, 8, 0x7f };
        var parameterBytes = Program.Utf8.GetBytes("7767517\nharmless fixture model\n");
        Probe.CreateFile(ModelBin, modelBytes); Probe.CreateFile(ModelParam, parameterBytes);
        var modelSet = JsonSerializer.SerializeToUtf8Bytes(new { v = 1, modelName = ModelName, files = new[] { Entry(ModelName + ".bin", modelBytes), Entry(ModelName + ".param", parameterBytes) } }, Program.Json);
        var modelSetPath = Path.Combine(ModelDirectory, "model-set.json");
        Probe.CreateFile(modelSetPath, modelSet);
        Selection = new("fixture-model", "fixture-cli-v1", Program.Hash(apphost), "fixture-model-v1", Program.Hash(modelSet), 4, 32, false, 0);
        var manifestBytes = JsonSerializer.SerializeToUtf8Bytes(new { v = 1, platform = "win-x64", recipeId = "upscayl-4x-png-v1", binaryVersion = Selection.BinaryVersion, entryPoint = "bin/upscayl-bin.exe", files = entries.ToArray(), models = new[] { new { modelId = Selection.ModelId, modelVersion = Selection.ModelVersion, modelDirectory = "models/fixture-model", modelName = ModelName, modelSetSha256 = Selection.ModelSha256 } } }, Program.Json);
        Probe.CreateFile(Manifest, manifestBytes);
        ManifestSha256 = Program.Hash(manifestBytes);
        DeclaredFiles = [Manifest, .. copied, modelSetPath, ModelBin, ModelParam];
        foreach (var path in DeclaredFiles) { using var handle = Probe.OpenFile(path); Probe.RequireProtected(handle); }
        using var rootHandle = Probe.OpenFile(root);
        Probe.RequireFixedNtfs(root, rootHandle);
        PublishFiles = fileEvidence.ToArray();
    }
    private static object Entry(string path, byte[] bytes) => new { path, length = bytes.LongLength.ToString(CultureInfo.InvariantCulture), sha256 = Program.Hash(bytes) };
    internal string[] Arguments(string input, string output)
    {
        return ["-i", input, "-o", output, "-m", ModelDirectory, "-n", ModelName, "-z", "4", "-t", "32", "-f", "png", "-g", "0"];
    }
    internal object Snapshot() => DeclaredFiles.Select(path => new { leaf = Path.GetRelativePath(Root, path).Replace('\\', '/'), file = Probe.FileEvidence(path) }).ToArray();
    internal object[] MutableModels() => new[] { ModelBin, ModelParam }.Select(path => (object)new { leaf = Path.GetFileName(path), write = Probe.OpenAttempt(path, 0x40000000), delete = Probe.OpenAttempt(path, 0x00010000), rename = Probe.RenameAttempt(path) }).ToArray();
}

internal sealed class EnginePeer : IDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly Frames frames = new();
    private readonly Task reader;
    private bool localClose;
    internal ProcessPin Pin { get; }
    internal string Role { get; }
    internal JsonElement Hello { get; }
    internal EnginePeer(NamedPipeServerStream pipe, ProcessPin pin, JsonElement hello)
    {
        this.pipe = pipe; Pin = pin; Hello = hello; Role = Program.Text(hello, "role");
        frames.Add(hello);
        reader = ReadAsync();
    }
    private async Task ReadAsync()
    {
        try
        {
            using var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true);
            while (await Program.ReadLineAsync(input, CancellationToken.None) is { } line) frames.Add(Program.Parse(line));
            frames.End();
        }
        catch (Exception error) when (localClose && error is IOException or ObjectDisposedException) { frames.End(); }
        catch (Exception error) { frames.End(error); throw; }
    }
    internal Task<JsonElement> StageAsync(string stage, CancellationToken token) => frames.MatchAsync(frame => Program.Text(frame, "stage") == stage, token);
    internal Task ReleaseAsync(string command, CancellationToken token) => Program.SendAsync(pipe, new { command }, token);
    internal async Task CloseAsync() { localClose = true; pipe.Dispose(); await reader; }
    public void Dispose() { localClose = true; pipe.Dispose(); Pin.Dispose(); }
}

internal sealed class EngineHub : IAsyncDisposable
{
    internal string Leaf { get; } = Program.Leaf("zeb-session-engine-");
    private readonly CancellationTokenSource shutdown = new();
    private readonly Frames accepted = new();
    private readonly List<EnginePeer> peers = [];
    private readonly Task accepts;
    private NamedPipeServerStream? pending;
    internal EngineHub() { pending = Probe.LocalServer(Leaf, true); accepts = AcceptAsync(); }
    private async Task AcceptAsync()
    {
        try
        {
            while (true)
            {
                var pipe = pending!;
                await pipe.WaitForConnectionAsync(shutdown.Token);
                pending = Probe.LocalServer(Leaf, false);
                Probe.Check(Probe.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid), "engine_actual_pipe_peer");
                ProcessPin? pin = null;
                try
                {
                    pin = ProcessPin.Open(pid);
                    using var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true);
                    var text = await Program.ReadLineAsync(input, shutdown.Token);
                    Program.Require(text is not null, "engine_no_hello");
                    var hello = Program.Parse(text!);
                    Program.Require(hello.GetProperty("identity").Deserialize<ProcessFact>(Program.Json) == pin.Identity && Program.Text(hello, "stage") == "loaded", "engine_original_peer_identity");
                    var peer = new EnginePeer(pipe, pin, hello);
                    lock (peers) peers.Add(peer);
                    pin = null;
                    accepted.Add(Program.Element(new { role = peer.Role }));
                }
                catch { pin?.Dispose(); pipe.Dispose(); throw; }
            }
        }
        catch (Exception error) when (shutdown.IsCancellationRequested && error is OperationCanceledException or ObjectDisposedException or IOException) { }
        catch (Exception error) { accepted.End(error); throw; }
    }
    internal async Task<EnginePeer> PeerAsync(string role, CancellationToken token)
    {
        await accepted.MatchAsync(frame => Program.Text(frame, "role") == role, token);
        lock (peers) return peers.Single(peer => peer.Role == role);
    }
    public async ValueTask DisposeAsync()
    {
        shutdown.Cancel(); pending?.Dispose();
        await accepts;
        EnginePeer[] original; lock (peers) original = peers.ToArray();
        foreach (var peer in original) { await peer.CloseAsync(); peer.Dispose(); }
        shutdown.Dispose();
    }
}

internal static class Engine
{
    private static async Task<(NamedPipeClientStream Pipe, JsonElement Config, ProcessFact Identity)> ConnectAsync(string input, string role, bool mark, string? pngControlPath = null)
    {
        var source = File.ReadAllBytes(input);
        bool png = source.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        Program.Require(!png || pngControlPath is not null, "png_engine_fixed_sidecar_required");
        var config = Program.Parse(Program.Utf8.GetString(png ? File.ReadAllBytes(pngControlPath!) : source));
        if (png)
        {
            Program.Exact(config, "pipe", "harness", "fixtureDeadlineUnixMs", "marker", "expectedArgv", "inputSha256");
            Program.Require(Program.Hash(source) == Program.Text(config, "inputSha256"), "png_engine_original_input_sha256");
        }
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        if (mark) Probe.CreateFile(Program.Text(config, "marker"), Program.Utf8.GetBytes(JsonSerializer.Serialize(self.Identity, Program.Json)));
        var pipe = new NamedPipeClientStream(".", Program.Text(config, "pipe"), PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, config.GetProperty("fixtureDeadlineUnixMs").GetInt64() - Program.Now)));
        await pipe.ConnectAsync(deadline.Token);
        Probe.Check(Probe.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid), "engine_harness_pipe_server");
        using var server = ProcessPin.Open(serverPid);
        Program.Require(server.Identity == config.GetProperty("harness").Deserialize<ProcessFact>(Program.Json), "engine_harness_original_identity");
        await Program.SendAsync(pipe, new { stage = "loaded", role, identity = self.Identity, stdoutCapacity = Probe.PipeCapacity(Probe.GetStdHandle(-11)), stderrCapacity = Probe.PipeCapacity(Probe.GetStdHandle(-12)) }, deadline.Token);
        return (pipe, config, self.Identity);
    }
    private static async Task<string> CommandAsync(StreamReader input, CancellationToken token)
    {
        var line = await Program.ReadLineAsync(input, token);
        Program.Require(line is not null, "engine_command_eof");
        var command = Program.Parse(line!); Program.Exact(command, "command"); return Program.Text(command, "command");
    }
    internal static async Task<int> RecipeAsync(string[] args)
    {
        Program.Require(args.Length == 16 && args[0] == "-i" && args[2] == "-o" && args[4] == "-m" && args[6] == "-n" && args[7] == Bundle.ModelName && args[8] == "-z" && args[9] == "4" && args[10] == "-t" && args[11] == "32" && args[12] == "-f" && args[13] == "png" && args[14] == "-g" && args[15] == "0", "engine_fixed_recipe");
        var (pipe, config, identity) = await ConnectAsync(args[1], "engine", true,
            Path.Combine(Path.GetDirectoryName(args[3])!, "engine-control.json"));
        using (pipe)
        using (var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true))
        using (var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, config.GetProperty("fixtureDeadlineUnixMs").GetInt64() - Program.Now))))
        {
            Program.Require(args.SequenceEqual(config.GetProperty("expectedArgv").EnumerateArray().Select(value => value.GetString()!)), "engine_independent_recipe_exact");
            ProcessPin? child = null;
            try
            {
                while (true)
                {
                    var command = await CommandAsync(input, deadline.Token);
                    if (command is "finish" or "finish-nonzero")
                    {
                        Console.Out.WriteLine("engine-stdout-商品🙂"); Console.Out.Flush();
                        Console.Error.WriteLine("engine-stderr-商品🙂"); Console.Error.Flush();
                        return command == "finish" ? 0 : unchecked((int)0x80000001u);
                    }
                    if (command == "capacity-write")
                    {
                        var stdoutCapacity = Probe.PipeCapacity(Probe.GetStdHandle(-11));
                        var stderrCapacity = Probe.PipeCapacity(Probe.GetStdHandle(-12));
                        var stdoutBytes = checked((int)stdoutCapacity + 1);
                        var stderrBytes = checked((int)stderrCapacity + 1);
                        // Both writes are admitted before either is awaited.
                        var output = Console.OpenStandardOutput(); var error = Console.OpenStandardError();
                        var outputWrite = Task.Run(async () => { await output.WriteAsync(Enumerable.Repeat((byte)'x', stdoutBytes).ToArray(), deadline.Token); await output.FlushAsync(deadline.Token); });
                        var errorWrite = Task.Run(async () => { await error.WriteAsync(Enumerable.Repeat((byte)'y', stderrBytes).ToArray(), deadline.Token); await error.FlushAsync(deadline.Token); });
                        await Task.WhenAll(outputWrite, errorWrite);
                        await Program.SendAsync(pipe, new { stage = "capacity-complete", role = "engine", identity, stdoutCapacity, stderrCapacity, stdoutBytes, stderrBytes, stdoutWriteCompleted = true, stderrWriteCompleted = true, concurrentWrites = true, capacitiesQueriedFromActualHandles = true }, deadline.Token);
                    }
                    else if (command == "spawn-child")
                    {
                        Program.Require(child is null, "engine_one_child");
                        child = Probe.SpawnInherited(Program.Self, ["descendant", args[1], "child"], Path.GetDirectoryName(args[1])!);
                        await Program.SendAsync(pipe, new { stage = "child-created", role = "engine", identity, child = child.Identity }, deadline.Token);
                    }
                    else if (command.StartsWith("observation-", StringComparison.Ordinal))
                        await RuntimeObservationScenarios.WriteEngineAsync(command, pipe, identity, deadline.Token);
                    else throw new InvalidDataException("engine_private_command");
                }
            }
            finally { child?.Dispose(); }
        }
    }
    internal static async Task<int> DescendantAsync(string inputPath, string role)
    {
        Program.Require(role is "child" or "grandchild", "descendant_role");
        var (pipe, config, identity) = await ConnectAsync(inputPath, role, false);
        using (pipe)
        using (var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true))
        using (var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, config.GetProperty("fixtureDeadlineUnixMs").GetInt64() - Program.Now))))
        {
            ProcessPin? child = null;
            try
            {
                while (true)
                {
                    var command = await CommandAsync(input, deadline.Token);
                    if (command == "finish") return 0;
                    Program.Require(command == "spawn-grandchild" && role == "child" && child is null, "descendant_one_grandchild");
                    child = Probe.SpawnInherited(Program.Self, ["descendant", inputPath, "grandchild"], Path.GetDirectoryName(inputPath)!);
                    await Program.SendAsync(pipe, new { stage = "grandchild-created", role, identity, child = child.Identity }, deadline.Token);
                }
            }
            finally { child?.Dispose(); }
        }
    }
}

internal sealed record BridgePlan(string Slot, string Stage, string Fault);

internal sealed class Bridge : IAsyncDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly CancellationTokenSource shutdown = new();
    private readonly TaskCompletionSource<ProcessFact> expected = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<(string ExecutionId, string RequestFingerprint)> originalBinding = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object bindingGate = new();
    private JsonElement? originalPrepared;
    private readonly TaskCompletionSource<JsonElement> reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly string nonce = Guid.NewGuid().ToString("N");
    private readonly BridgePlan plan;
    private readonly TaskCompletionSource<JsonElement> observationSettled = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource observationReleaseWritten = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool observationReleaseStarted, observationSettledRead, observationEof;
    private readonly Task reader;
    private bool released;
    internal JsonElement Configuration { get; }
    internal Bridge(BridgePlan plan, long? fixtureDeadlineUnixMs = null)
    {
        this.plan = plan;
        var leaf = Program.Leaf("zeb-session-test-");
        pipe = Probe.LocalServer(leaf, true);
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        Configuration = fixtureDeadlineUnixMs is long deadline
            ? Program.Element(new { v = 1, pipe = leaf, harnessPid = self.Identity.Pid, harnessCreatedFileTime = self.Identity.CreationFileTime, nonce, plan, fixtureDeadlineUnixMs = deadline })
            : Program.Element(new { v = 1, pipe = leaf, harnessPid = self.Identity.Pid, harnessCreatedFileTime = self.Identity.CreationFileTime, nonce, plan });
        reader = ReceiveAsync();
    }
    internal void Bind(ProcessFact helper) => Program.Require(expected.TrySetResult(helper), "bridge_original_bound_once");
    internal void BindExecution(string executionId, string requestFingerprint) => Program.Require(originalBinding.TrySetResult((executionId, requestFingerprint)), "bridge_original_execution_bound_once");
    internal void BindPrepared(JsonElement descriptor)
    {
        Program.Require(originalBinding.Task.IsCompletedSuccessfully, "bridge_original_execution_not_bound");
        var original = originalBinding.Task.Result;
        Program.Require(Program.Text(descriptor, "executionId") == original.ExecutionId && Program.Text(descriptor.GetProperty("details"), "requestFingerprint") == original.RequestFingerprint, "bridge_original_prepared_scope_mismatch");
        lock (bindingGate)
        {
            Program.Require(!originalPrepared.HasValue || JsonElement.DeepEquals(originalPrepared.Value, descriptor), "bridge_original_prepared_changed");
            originalPrepared = descriptor.Clone();
        }
    }
    private void ValidateObservation(JsonElement stage)
    {
        Program.Require(originalBinding.Task.IsCompletedSuccessfully, "bridge_original_execution_not_bound");
        var original = originalBinding.Task.Result;
        var observation = stage.GetProperty("observation");
        if (plan.Slot == "observation")
            Program.Exact(observation, "executionId", "requestFingerprint", "phase", "sealReason", "engine", "jobName", "journal", "runtimeObservationTest");
        else if (observation.TryGetProperty("business", out _))
            Program.Exact(observation, "executionId", "requestFingerprint", "phase", "sealReason", "engine", "jobName", "journal", "business");
        else Program.Exact(observation, "executionId", "requestFingerprint", "phase", "sealReason", "engine", "jobName", "journal");
        Program.Require(Program.Text(observation, "executionId") == original.ExecutionId && Program.Text(observation, "requestFingerprint") == original.RequestFingerprint, "bridge_original_observation_scope_mismatch");
        lock (bindingGate)
        {
            if (!originalPrepared.HasValue) return;
            var details = originalPrepared.Value.GetProperty("details");
            Program.Require(JsonElement.DeepEquals(observation.GetProperty("engine"), details.GetProperty("engine")) && Program.Text(observation, "jobName") == Program.Text(details, "jobName"), "bridge_original_prepared_engine_job_mismatch");
        }
    }
    private async Task ReceiveAsync()
    {
        try
        {
            await pipe.WaitForConnectionAsync(shutdown.Token);
            Probe.Check(Probe.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid), "bridge_actual_helper_peer");
            using var client = ProcessPin.Open(pid);
            Program.Require(client.Identity == await expected.Task.WaitAsync(shutdown.Token) && client.Alive, "bridge_original_helper_identity");
            await originalBinding.Task.WaitAsync(shutdown.Token);
            using var input = new StreamReader(pipe, Program.Utf8, false, leaveOpen: true);
            var line = await Program.ReadLineAsync(input, shutdown.Token);
            if (line is null && plan.Slot == "observation") { observationEof = true; return; }
            Program.Require(line is not null, "bridge_no_stage");
            var stage = Program.Parse(line!);
            Program.Exact(stage, "v", "kind", "nonce", "sequence", "slot", "stage", "observation");
            Program.Require(stage.GetProperty("v").GetInt32() == 1 && Program.Text(stage, "kind") == "reached" && Program.Text(stage, "nonce") == nonce && stage.GetProperty("sequence").GetInt64() > 0 && Program.Text(stage, "slot") == plan.Slot && Program.Text(stage, "stage") == plan.Stage, "bridge_exact_stage_binding");
            ValidateObservation(stage);
            if (plan.Slot == "observation") Program.Require(stage.GetProperty("sequence").GetRawText() == "1", "observation_first_sequence");
            Program.Require(reached.TrySetResult(stage), "bridge_single_barrier");
            if (plan.Slot == "observation")
            {
                var finalLine = await Program.ReadLineAsync(input, shutdown.Token);
                Program.Require(finalLine is not null, "observation_settled_missing");
                Volatile.Write(ref observationSettledRead, true);
                Program.Require(Volatile.Read(ref observationReleaseStarted), "observation_settled_before_release");
                await observationReleaseWritten.Task.WaitAsync(shutdown.Token);
                var final = Program.Parse(finalLine!);
                Program.Exact(final, "v", "kind", "nonce", "sequence", "slot", "stage", "observation");
                Program.Require(final.GetProperty("v").GetRawText() == "1" && Program.Text(final, "kind") == "settled" &&
                    Program.Text(final, "nonce") == nonce && final.GetProperty("sequence").GetRawText() == "2" &&
                    Program.Text(final, "slot") == plan.Slot && Program.Text(final, "stage") == plan.Stage,
                    "observation_settled_original_binding");
                ValidateObservation(final);
                Program.Require(observationSettled.TrySetResult(final), "observation_one_settled");
            }
            // Continue reading only to prove that no uncorrelated second stage
            // or command bag appears. The original release is sent separately.
            while (await Program.ReadLineAsync(input, shutdown.Token) is { }) throw new InvalidDataException("bridge_extra_frame");
            if (plan.Slot == "observation") observationEof = true;
        }
        catch (Exception error) when (shutdown.IsCancellationRequested && error is OperationCanceledException or IOException or ObjectDisposedException) { }
        catch (Exception error) { reached.TrySetException(error); observationSettled.TrySetException(error); throw; }
    }
    internal async Task<JsonElement> ReachedAsync(CancellationToken token) { var stage = await reached.Task.WaitAsync(token); ValidateObservation(stage); return stage; }
    internal async Task ReleaseAsync(CancellationToken token)
    {
        Program.Require(!released, "bridge_no_second_release");
        var original = await ReachedAsync(token);
        if (plan.Slot == "observation") Volatile.Write(ref observationReleaseStarted, true);
        await Program.SendAsync(pipe, new { v = 1, kind = "release", nonce, sequence = original.GetProperty("sequence").GetInt64() }, token);
        released = true;
        if (plan.Slot == "observation") observationReleaseWritten.TrySetResult();
    }
    internal bool ObservationReached => reached.Task.IsCompletedSuccessfully;
    internal bool ObservationSettledReceived => Volatile.Read(ref observationSettledRead);
    internal async Task<JsonElement> ObservationSettledAsync(CancellationToken token) => await observationSettled.Task.WaitAsync(token);
    internal async Task<bool> ObservationEofAsync(CancellationToken token)
    {
        await reader.WaitAsync(token);
        return observationEof;
    }
    internal object ProbeJournal(JsonElement stage)
    {
        ValidateObservation(stage);
        var journal = stage.GetProperty("observation").GetProperty("journal");
        Program.Exact(journal, "originalHandle", "selectedHandle");
        object result;
        using (var original = new SafeFileHandle(Probe.Pointer(Program.Text(journal, "originalHandle")), true))
        using (var selected = new SafeFileHandle(Probe.Pointer(Program.Text(journal, "selectedHandle")), true))
        {
            var first = Probe.FileIdentity(original); var second = Probe.FileIdentity(selected);
            var originalAccess = Probe.GrantedAccess(original); var selectedAccess = Probe.GrantedAccess(selected);
            var before = Probe.Bytes(original);
            Probe.RequireProtected(original); Probe.RequireProtected(selected);
            int nativeError;
            if (plan.Fault == "WriteReadOnly")
            {
                var bytes = Program.Utf8.GetBytes("denied-test-write");
                var success = Probe.WriteFile(selected, bytes, (uint)bytes.Length, out _, IntPtr.Zero);
                nativeError = success ? 0 : Marshal.GetLastWin32Error();
                Program.Require(!success, "bridge_selected_write_unexpectedly_allowed");
            }
            else
            {
                var success = Probe.FlushFileBuffers(selected);
                nativeError = success ? 0 : Marshal.GetLastWin32Error();
                Program.Require(!success, "bridge_selected_flush_unexpectedly_allowed");
            }
            Program.Require(first == second && (originalAccess & 2) != 0 && (selectedAccess & 2) == 0 && nativeError == 5 && before.AsSpan().SequenceEqual(Probe.Bytes(original)), "bridge_real_readonly_io_boundary");
            result = new { originalIdentity = first, selectedIdentity = second, sameObject = first == second, originalNonInherited = Probe.NonInherited(original), selectedNonInherited = Probe.NonInherited(selected), originalGrantedAccess = originalAccess, selectedGrantedAccess = selectedAccess, originalCanWrite = (originalAccess & 2) != 0, selectedCanWrite = (selectedAccess & 2) != 0, independentNativeError = nativeError, duplicatesClosedBeforeRelease = true };
        }
        Program.Require(!released, "bridge_duplicate_close_precedes_release");
        return result;
    }
    public async ValueTask DisposeAsync() { shutdown.Cancel(); pipe.Dispose(); await reader; shutdown.Dispose(); }
}

internal static class Readback
{
    internal static readonly string RequestId = "00000000000000000000000000000001";
    internal static readonly string PreparedId = "00000000000000000000000000000002";
    internal static readonly string AuthId = "00000000000000000000000000000003";
    internal static readonly string ReservedId = "00000000000000000000000000000004";
    internal static readonly string LossId = "00000000000000000000000000000005";
    internal static readonly string TerminalId = "00000000000000000000000000000006";
    internal static string[] Slots => [RequestId, PreparedId, AuthId, ReservedId, LossId, TerminalId];
    internal static string Key(JournalScope scope) => Program.Hash(Program.Utf8.GetBytes(scope.Target.LaunchTicket));
    internal static string RecordPath(string root, JournalScope scope, string id) => Path.Combine(root, Key(scope) + ".record-" + id + ".json");
    internal static object Result(JournalResult result) => new { status = result.Status.ToString(), snapshot = result.Snapshot, ownerPresent = result.Owner is not null, diagnostic = result.Diagnostic };
    internal static object RawSnapshot(string root, JournalScope scope) => new[] { Path.Combine(root, Key(scope) + ".reserved"), Path.Combine(root, Key(scope) + ".reservation.json") }.Concat(Slots.Select(id => RecordPath(root, scope, id))).Select(path => new { leaf = Path.GetFileName(path), present = File.Exists(path), file = File.Exists(path) ? Probe.FileEvidence(path, includeBytes: true) : null }).ToArray();
    internal static async Task<int> RunAsync()
    {
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        Program.Write(new { kind = "actor-ready", identity = self.Identity, nonInherited = self.NonInherited, sameSid = self.SameSid });
        using var input = new StreamReader(Console.OpenStandardInput(), Program.Utf8, false, leaveOpen: true);
        while (await Program.ReadLineAsync(input, CancellationToken.None) is { } line)
        {
            var command = Program.Parse(line); var id = command.GetProperty("id").GetInt32();
            try
            {
                if (Program.Text(command, "op") == "exit") { Program.Write(new { kind = "reply", id, ok = true, value = new { code = 0 } }); return 0; }
                Program.Require(Program.Text(command, "op") == "read", "readback_fixed_op");
                var value = command.GetProperty("value");
                var root = Program.Text(value, "root");
                var scope = value.GetProperty("scope").Deserialize<JournalScope>(Program.Json)!;
                var executionId = Program.Text(value, "executionId");
                var reservation = ProtectedJournal.InspectReservation(root, scope);
                var records = Slots.ToDictionary(slot => slot, slot => Result(ProtectedJournal.Read(root, scope, executionId, slot)));
                Program.Write(new { kind = "reply", id, ok = true, value = new { reservation = Result(reservation), records, loadedAssemblySha256 = Program.Hash(File.ReadAllBytes(typeof(ProtectedJournal).Assembly.Location)) } });
            }
            catch (Exception error) { Program.Write(new { kind = "reply", id, ok = false, value = Program.Error(error) }); }
        }
        return 0;
    }
}

internal sealed record Session(Rpc Controller, Rpc Observer, Subject Subject, string Leaf, Bridge? Bridge)
{
    internal JsonElement? OriginalAuthorizeRequest { get; set; }
}

internal sealed class RunContext : IAsyncDisposable
{
    internal string Scenario { get; }
    internal string Directory { get; }
    internal string RecordsRoot => Path.Combine(Directory, "records");
    internal string Marker => Path.Combine(Directory, "first-action.json");
    internal string InputPath => Path.Combine(Directory, "input 商品 🙂.json");
    internal string OutputPath => Path.Combine(Directory, "output 商品 🙂.png");
    internal string OrdinaryExe { get; }
    internal string TestExe { get; }
    internal string OrdinaryDll { get; }
    internal long DeadlineTick { get; }
    internal Bundle Bundle { get; }
    internal EngineHub Hub { get; }
    internal JsonElement Carrier { get; private set; }
    internal JsonElement Spec { get; private set; }
    internal JournalScope Scope { get; private set; } = null!;
    internal Dictionary<string, object?> Values { get; } = [];
    internal List<Rpc> Actors { get; } = [];
    internal List<Child> DirectChildren { get; } = [];
    internal List<Subject> Subjects { get; } = [];
    internal List<ProcessPin> EnginePins { get; } = [];
    private readonly List<SafeFileHandle> jobHandles = [];
    private readonly List<Bridge> bridges = [];
    private readonly Frames input;
    private int requestSequence;
    private bool readerRegistrationRequested;
    internal RunContext(string scenario, string directory, string ordinaryExe, string testExe, string ordinaryDll, long deadlineTick, Frames input)
    {
        Scenario = scenario; Directory = directory; OrdinaryExe = ordinaryExe; TestExe = testExe; OrdinaryDll = ordinaryDll; DeadlineTick = deadlineTick; this.input = input;
        Probe.CreateDirectory(RecordsRoot);
        Bundle = new Bundle(Path.Combine(directory, "installation"));
        Hub = new EngineHub();
    }
    internal async Task RegisterAsync(ProcessPin pin, CancellationToken token)
    {
        Program.Write(new { kind = "registered", identity = pin.Identity });
        await input.MatchAsync(frame => frame.TryGetProperty("registrationAck", out var actual) && actual.Deserialize<ProcessFact>(Program.Json) == pin.Identity, token);
    }
    internal async Task<ProcessPin> RegisterObservedReaderAsync(uint candidatePid, CancellationToken token)
    {
        Program.Require(Program.ReaderPinEnabled && !readerRegistrationRequested && candidatePid > 0, "reader_inner_registration_once");
        readerRegistrationRequested = true;
        Program.Write(new { kind = "registered", registrationSource = "original-reader-job-notification", candidatePid });
        var ack = await input.MatchAsync(frame => frame.TryGetProperty("registrationSource", out var source) && source.GetString() == "original-reader-job-notification", token);
        var handle = new SafeFileHandle(Probe.Pointer(Program.Text(ack, "originalHandle")), true);
        ProcessPin? pin = null;
        try
        {
            Program.Exact(ack, "registrationAck", "registrationSource", "originalHandle");
            var identity = ack.GetProperty("registrationAck");
            Program.Exact(identity, "pid", "creationFileTime");
            var expected = identity.Deserialize<ProcessFact>(Program.Json)!;
            pin = ProcessPin.Adopt(handle, expected);
            Program.Require(expected.Pid == candidatePid && pin.NonInherited && pin.SameSid && pin.Alive, "reader_inner_original_adopt_binding");
            return pin;
        }
        catch { if (pin is null) handle.Dispose(); else pin.Dispose(); throw; }
    }
    internal async Task<JsonElement> MetadataAsync(int executionMs, int cleanupMs, CancellationToken token)
    {
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        var started = Program.Now;
        var deadline = checked(started + executionMs);
        if (Scenario.StartsWith("deadline", StringComparison.Ordinal)) { started = checked(started - executionMs + cleanupMs); deadline = checked(started + executionMs); }
        if (Scenario == "prepare-no-receipt-slow-diagnostic") { started = checked(started - executionMs + 12000); deadline = checked(started + executionMs); }
        if (Scenario == "long-deadline-grace") deadline = checked(started + (long)uint.MaxValue - 1 + executionMs);
        var target = new JournalTarget(new("session-fixture-job", 1, "session-fixture-owner", 1), Program.Leaf("session-launch-"));
        var engineConfig = new { pipe = Hub.Leaf, marker = Marker, harness = self.Identity, fixtureDeadlineUnixMs = Program.Now + Math.Max(0, DeadlineTick - Environment.TickCount64), expectedArgv = Bundle.Arguments(InputPath, OutputPath) };
        Probe.CreateFile(InputPath, JsonSerializer.SerializeToUtf8Bytes(engineConfig, Program.Json));
        Values["manifestSha256"] = Bundle.ManifestSha256;
        Values["expectedArgv"] = Bundle.Arguments(InputPath, OutputPath);
        var metadata = Program.Element(new { target, engine = Bundle.Selection, inputPath = InputPath, outputPath = OutputPath, workingDirectory = Directory, firstStartedAt = started, executionDeadlineAt = deadline });
        Program.Write(new { kind = "metadata", value = metadata });
        var request = await input.MatchAsync(frame => frame.TryGetProperty("requestUtf8Base64", out _), token);
        Program.Exact(request, "requestUtf8Base64", "requestFingerprint");
        Carrier = request;
        var bytes = Convert.FromBase64String(Program.Text(request, "requestUtf8Base64"));
        Program.Require(Convert.ToBase64String(bytes) == Program.Text(request, "requestUtf8Base64") && Program.Hash(bytes) == Program.Text(request, "requestFingerprint"), "fixture_raw_carrier_binding");
        Spec = Program.Parse(Program.Utf8.GetString(bytes));
        Scope = new(target, Program.Text(Spec.GetProperty("executionPolicy"), "fingerprint"));
        Program.Require(JsonElement.DeepEquals(Spec.GetProperty("target"), Program.Element(target)) && JsonElement.DeepEquals(Spec.GetProperty("engine"), Program.Element(Bundle.Selection)) && Program.Text(Spec, "inputPath") == InputPath && Program.Text(Spec, "outputPath") == OutputPath, "fixture_request_independent_binding");
        return metadata;
    }
    internal JsonElement Request(string op, string executionId, object? extension = null)
    {
        var fields = new Dictionary<string, JsonElement> { ["v"] = Program.Element(1), ["requestId"] = Program.Element("request-" + Interlocked.Increment(ref requestSequence).ToString(CultureInfo.InvariantCulture)), ["op"] = Program.Element(op), ["executionId"] = Program.Element(executionId) };
        if (extension is not null) foreach (var field in Program.Element(extension).EnumerateObject()) fields.Add(field.Name, field.Value.Clone());
        return Program.Element(fields);
    }
    internal JsonElement PrepareRequest(Session session) => Request("prepare", session.Subject.ExecutionId!, Carrier);
    internal JsonElement AuthorizeRequest(Session session, JsonElement descriptor) => Request("authorize", session.Subject.ExecutionId!, new { target = Scope.Target, descriptor, requestFingerprint = Program.Text(Carrier, "requestFingerprint") });
    internal JsonElement BindOriginalAuthorize(Session session, JsonElement descriptor)
    {
        Program.Require(!session.OriginalAuthorizeRequest.HasValue, "original_authorize_request_bound_once");
        var request = AuthorizeRequest(session, descriptor);
        session.OriginalAuthorizeRequest = request.Clone();
        Values["originalAuthorizeRequest"] = request;
        return request;
    }
    internal async Task<bool> ObserveAuthorizeAckAsync(Session session, CancellationToken token)
    {
        var request = session.OriginalAuthorizeRequest ?? throw new InvalidDataException("original_authorize_request_missing");
        JsonElement snapshot;
        string source;
        var exitReply = session.Controller.ExitReply;
        if (exitReply.HasValue)
        {
            Program.Require(session.Controller.Child.OriginalJoined && session.Controller.Child.Pin?.Alive is false, "original_controller_exit_reply_not_joined");
            snapshot = exitReply.Value.GetProperty("pipes").GetProperty("owner").Clone();
            source = "original-controller-exit-reply";
        }
        else
        {
            snapshot = await session.Controller.CallAsync("wait-closed", new { key = "owner" }, token);
            source = "original-owner-reader-joined";
        }
        var connection = snapshot.GetProperty("connection");
        Program.Require(JsonElement.DeepEquals(connection.GetProperty("server"), Program.Element(session.Subject.Pin.Identity)) && JsonElement.DeepEquals(connection.GetProperty("client"), Program.Element(session.Controller.Child.Pin!.Identity)), "authorize_ack_original_pipe_identity_mismatch");
        var sent = snapshot.GetProperty("sent").EnumerateArray().Where(frame => Program.Text(frame, "requestId") == Program.Text(request, "requestId")).ToArray();
        Program.Require(sent.Length == 1 && JsonElement.DeepEquals(sent[0], request) && Program.Text(request, "executionId") == session.Subject.ExecutionId, "authorize_ack_original_sent_request_mismatch");
        var matching = snapshot.GetProperty("frames").EnumerateArray().Where(frame => Program.Text(frame, "kind") == "response" && frame.GetProperty("requestId").ValueKind == JsonValueKind.String && Program.Text(frame, "requestId") == Program.Text(request, "requestId")).ToArray();
        foreach (var frame in matching) Program.Require(Program.Text(frame, "op") == "authorize" && Program.Text(frame, "executionId") == session.Subject.ExecutionId && Program.Text(frame, "role") == "owner", "authorize_ack_original_response_binding_mismatch");
        var successAuthorizeAck = matching.Any(frame => Program.Text(frame.GetProperty("state"), "resumeState") == "succeeded");
        Values["authorizeAckObservation"] = new { originalRequest = request, originalHelper = session.Subject.Pin.Identity, originalController = session.Controller.Child.Pin!.Identity, snapshotSource = source, originalOwnerReaderJoined = true, ownerSnapshot = snapshot, matchingReceivedResponses = matching, successAuthorizeAck };
        Program.Require(snapshot.GetProperty("readerError").ValueKind == JsonValueKind.Null && (snapshot.GetProperty("actualEof").GetBoolean() || snapshot.GetProperty("localClose").GetBoolean()), "authorize_ack_reader_not_cleanly_joined");
        return successAuthorizeAck;
    }
    internal async Task<Rpc> AgentAsync(CancellationToken token)
    {
        var actor = new Rpc(Program.Self, Directory, "agent", Environment.ProcessId.ToString(CultureInfo.InvariantCulture), Directory, DeadlineTick.ToString(CultureInfo.InvariantCulture));
        Actors.Add(actor); actor.Start(); await actor.ReadyAsync(token); await RegisterAsync(actor.Child.Pin!, token); return actor;
    }
    internal async Task<Session> SessionAsync(CancellationToken token, bool legacy = false, BridgePlan? plan = null, bool fixtureStopGate = false)
    {
        var controller = await AgentAsync(token);
        var leaf = Program.Leaf("zeb-control-");
        var bridge = plan is null ? null : fixtureStopGate
            ? new Bridge(plan, checked(Program.Now + Math.Max(0, DeadlineTick - Environment.TickCount64))) : new Bridge(plan);
        if (bridge is not null) bridges.Add(bridge);
        var args = legacy
            ? new[] { "--pipe", leaf, "--controller-pid", controller.Child.Pin!.Identity.Pid.ToString(CultureInfo.InvariantCulture) }
            : new[] { "--pipe", leaf, "--controller-pid", controller.Child.Pin!.Identity.Pid.ToString(CultureInfo.InvariantCulture), "--records-root", RecordsRoot, "--installation-root", Bundle.Root, "--expected-manifest-sha256", Bundle.ManifestSha256 };
        var handoff = await controller.CallAsync("launch", new { executable = bridge is null ? OrdinaryExe : TestExe, args, bridge = bridge?.Configuration }, token);
        var subject = new Subject(handoff); Subjects.Add(subject); bridge?.Bind(subject.Pin.Identity);
        await RegisterAsync(subject.Pin, token); await subject.StartupAsync(token);
        bridge?.BindExecution(subject.ExecutionId!, Program.Text(Carrier, "requestFingerprint"));
        await controller.CallAsync("open", new { key = "owner", leaf, expected = subject.Pin.Identity, executionId = subject.ExecutionId }, token);
        var observer = await AgentAsync(token);
        await observer.CallAsync("open", new { key = "observer", leaf, expected = subject.Pin.Identity, executionId = subject.ExecutionId }, token);
        var session = new Session(controller, observer, subject, leaf, bridge);
        Values["claim"] = await ExchangeAsync(session, "claim", token);
        Values["watch"] = await ExchangeAsync(session, "watch", token, observer: true);
        return session;
    }
    internal Task<JsonElement> ExchangeAsync(Session session, string op, CancellationToken token, bool observer = false) => (observer ? session.Observer : session.Controller).CallAsync("exchange", new { key = observer ? "observer" : "owner", request = Request(op, session.Subject.ExecutionId!) }, token);
    internal Task<JsonElement> ExchangeFrameAsync(Session session, JsonElement request, CancellationToken token, bool observer = false) => (observer ? session.Observer : session.Controller).CallAsync("exchange", new { key = observer ? "observer" : "owner", request }, token);
    internal Task SendFrameAsync(Session session, JsonElement request, CancellationToken token) => session.Controller.CallAsync("send", new { key = "owner", request }, token);
    internal Task<JsonElement> ReplyAsync(Session session, JsonElement request, CancellationToken token, bool acceptNull = false) => session.Controller.CallAsync("response", new { key = "owner", requestId = Program.Text(request, "requestId"), acceptNull }, token);
    internal Task<JsonElement> EventAsync(Session session, string property, string value, CancellationToken token) => session.Observer.CallAsync("event", new { key = "observer", property, match = value }, token);
    internal async Task<JsonElement> PrepareAsync(Session session, CancellationToken token)
    {
        var reply = await ExchangeFrameAsync(session, PrepareRequest(session), token);
        Values["prepare"] = reply;
        Program.Require(Program.Text(reply, "kind") == "response" && Program.Text(reply.GetProperty("state"), "phase") == "prepared", "actual_program_did_not_prepare");
        var descriptor = reply.GetProperty("state").GetProperty("descriptor").Clone();
        PinDescriptor(descriptor);
        session.Bridge?.BindPrepared(descriptor);
        return descriptor;
    }
    internal ProcessPin PinFact(JsonElement fact)
    {
        var expected = fact.Deserialize<ProcessFact>(Program.Json)!;
        var existing = EnginePins.SingleOrDefault(pin => pin.Identity == expected);
        if (existing is not null) return existing;
        var pin = ProcessPin.Open(expected.Pid);
        if (pin.Identity != expected) { pin.Dispose(); throw new InvalidDataException("engine_original_identity_changed"); }
        EnginePins.Add(pin); return pin;
    }
    internal void PinDescriptor(JsonElement descriptor)
    {
        var details = descriptor.GetProperty("details");
        PinFact(details.GetProperty("engine"));
    }
    internal ProcessPin? PinStage(JsonElement stage)
    {
        var observation = stage.GetProperty("observation");
        if (observation.GetProperty("engine").ValueKind == JsonValueKind.Null) return null;
        return PinFact(observation.GetProperty("engine"));
    }
    internal SafeFileHandle OpenJob(string jobName, bool terminate = false)
    {
        var handle = Probe.OpenJobObjectW(terminate ? 0x000cu : 0x0004u, false, jobName);
        Probe.Check(!handle.IsInvalid, "independent_original_job_open");
        Program.Require(Probe.NonInherited(handle), "original_job_query_noninherit");
        jobHandles.Add(handle); return handle;
    }
    internal void CloseJobHandles() { foreach (var handle in jobHandles) handle.Dispose(); jobHandles.Clear(); }
    internal object PreparedProbe(JsonElement descriptor)
    {
        var details = descriptor.GetProperty("details"); var pin = PinFact(details.GetProperty("engine"));
        var job = OpenJob(Program.Text(details, "jobName")); var accounting = Probe.JobAccounting(job);
        var result = new { engine = pin.Identity, engineLive = pin.Alive, engineInOriginalJob = Probe.InJob(pin.Handle, job), activeProcesses = accounting.ActiveProcesses, totalProcesses = accounting.TotalProcesses, firstActionAbsent = !File.Exists(Marker) };
        Program.Require(result.engineLive && result.engineInOriginalJob && accounting.ActiveProcesses == 1 && accounting.TotalProcesses == 1 && result.firstActionAbsent, "independent_suspended_original_engine");
        return result;
    }
    internal async Task<EnginePeer> PeerAsync(string role, JsonElement descriptor, CancellationToken token)
    {
        var peer = await Hub.PeerAsync(role, token);
        if (!EnginePins.Any(pin => pin.Identity == peer.Pin.Identity)) EnginePins.Add(ProcessPin.Duplicate(peer.Pin.Handle));
        await RegisterAsync(peer.Pin, token);
        var job = OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"));
        Program.Require(Probe.InJob(peer.Pin.Handle, job), "real_engine_peer_in_original_job");
        return peer;
    }
    internal async Task ReadbackAsync(Session session, CancellationToken token)
    {
        Program.Require(session.Subject.Pin.Joined && !session.Subject.Pin.Alive, "strict_reopen_requires_writer_closed");
        var before = Readback.RawSnapshot(RecordsRoot, Scope);
        var actor = new Rpc(Program.Self, Directory, "readback"); Actors.Add(actor); actor.Start(); await actor.ReadyAsync(token); await RegisterAsync(actor.Child.Pin!, token);
        var strict = await actor.CallAsync("read", new { root = RecordsRoot, scope = Scope, executionId = session.Subject.ExecutionId }, token);
        Program.Require(Program.Text(strict, "loadedAssemblySha256") == Program.Hash(File.ReadAllBytes(OrdinaryDll)), "strict_reader_ordinary_artifact_hash");
        await actor.ExitAsync(token);
        var after = Readback.RawSnapshot(RecordsRoot, Scope);
        Values["readback"] = new { writerClosed = true, root = Probe.FileEvidence(RecordsRoot), before, after, strict };
        Program.Require(Program.Equal(before, after), "strict_reader_mutated_original_evidence");
    }
    internal object ReaderFiles() => new { root = Probe.FileEvidence(RecordsRoot), entries = System.IO.Directory.EnumerateFileSystemEntries(RecordsRoot).Order(StringComparer.Ordinal).Select(path => new { leaf = Path.GetFileName(path), file = Probe.FileEvidence(path, includeBytes: true) }).ToArray() };
    internal async Task ReadRecoveryAsync(string originalExecutionId, string variant, bool writerClosed, CancellationToken token)
    {
        var fixedSlots = new[] { Readback.RequestId, Readback.PreparedId, Readback.AuthId, Readback.LossId, Readback.TerminalId };
        var reservation = ProtectedJournal.InspectReservation(RecordsRoot, Scope);
        var records = fixedSlots.ToDictionary(slot => slot, slot => Readback.Result(ProtectedJournal.Read(RecordsRoot, Scope, originalExecutionId, slot)));
        Values["readerControl"] = new { writerClosed, originalScope = Scope, originalExecutionId, reservation = Readback.Result(reservation), records, loadedAssemblySha256 = Program.Hash(File.ReadAllBytes(typeof(ProtectedJournal).Assembly.Location)), ordinaryAssemblySha256 = Program.Hash(File.ReadAllBytes(OrdinaryDll)) };
        var request = JsonNode.Parse(JsonSerializer.Serialize(new { v = 1, kind = "read-windows-journal", scope = Scope, executionId = originalExecutionId }, Program.Json))!.AsObject();
        var scope = request["scope"]!.AsObject(); var target = scope["target"]!.AsObject(); var identity = target["identity"]!.AsObject();
        switch (variant)
        {
            case "wrong-scope": identity["ownerInstanceId"] = "other-reader-owner"; break;
            case "wrong-id": request["executionId"] = originalExecutionId == new string('a', 32) ? new string('b', 32) : new string('a', 32); break;
            case "extra-top": request["extra"] = true; break;
            case "extra-scope": scope["extra"] = true; break;
            case "extra-target": target["extra"] = true; break;
            case "extra-identity": identity["extra"] = true; break;
            case "missing-top": request.Remove("kind"); break;
            case "missing-scope": scope.Remove("executionPolicyFingerprint"); break;
            case "missing-target": target.Remove("launchTicket"); break;
            case "missing-identity": identity.Remove("ownerInstanceId"); break;
            case "attempt-zero": identity["attemptNo"] = 0; break;
            case "attempt-negative": identity["attemptNo"] = -1; break;
            case "attempt-unsafe": identity["attemptNo"] = 9007199254740992L; break;
            case "fence-zero": identity["fence"] = 0; break;
            case "fence-unsafe": identity["fence"] = 9007199254740992L; break;
            case "bad-policy": scope["executionPolicyFingerprint"] = new string('A', 64); break;
            case "bad-id": request["executionId"] = new string('A', 32); break;
            case "bad-identifier": identity["ownerInstanceId"] = " trailing "; break;
            case "wrong-kind": request["kind"] = "read-journal"; break;
        }
        var text = request.ToJsonString(Program.Json);
        text = variant switch
        {
            "valid" => request.ToJsonString(new JsonSerializerOptions(Program.Json) { WriteIndented = true }) + " \n\t",
            "malformed" => "{]",
            "truncated" => text[..^1],
            "second-json" => text + "\n{}",
            "trailing-text" => text + "\nx",
            "duplicate-top" => text.Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal),
            "duplicate-scope" => text.Replace("\"executionPolicyFingerprint\":", "\"executionPolicyFingerprint\":\"" + Scope.ExecutionPolicyFingerprint + "\",\"executionPolicyFingerprint\":", StringComparison.Ordinal),
            "duplicate-target" => text.Replace("\"launchTicket\":", "\"launchTicket\":" + JsonSerializer.Serialize(Scope.Target.LaunchTicket) + ",\"launchTicket\":", StringComparison.Ordinal),
            "duplicate-identity" => text.Replace("\"attemptNo\":1", "\"attemptNo\":1,\"attemptNo\":1", StringComparison.Ordinal),
            "version-decimal" => text.Replace("\"v\":1", "\"v\":1.0", StringComparison.Ordinal),
            "version-exponent" => text.Replace("\"v\":1", "\"v\":1e0", StringComparison.Ordinal),
            "attempt-decimal" => text.Replace("\"attemptNo\":1", "\"attemptNo\":1.0", StringComparison.Ordinal),
            "attempt-exponent" => text.Replace("\"attemptNo\":1", "\"attemptNo\":1e0", StringComparison.Ordinal),
            "fence-exponent" => text.Replace("\"fence\":1", "\"fence\":1e0", StringComparison.Ordinal),
            "lossy-unicode" => text.Replace("\"session-fixture-owner\"", "\"\\ud800\"", StringComparison.Ordinal),
            "root-array" => "[]",
            _ => text,
        };
        var bytes = variant == "bad-utf8" ? Program.Utf8.GetBytes(text).Concat(new byte[] { 0xff }).ToArray() : Program.Utf8.GetBytes(text);
        var args = variant switch
        {
            "relative-root" => new[] { "--read-records", "records" },
            "unc-root" => new[] { "--read-records", @"\\reader-fixture\records" },
            "missing-cli-root" => new[] { "--read-records" },
            "extra-cli" => new[] { "--read-records", RecordsRoot, "extra" },
            _ => new[] { "--read-records", RecordsRoot },
        };
        var before = ReaderFiles();
        var child = new Child(OrdinaryExe, Directory, args); DirectChildren.Add(child);
        child.Start(preserveFraming: true); await RegisterAsync(child.Pin!, token);
        object? inputWriteFailure = null;
        var inputClosed = false;
        try
        {
            await child.Input.BaseStream.WriteAsync(bytes, token);
            await child.Input.BaseStream.FlushAsync(token);
            child.Input.Close();
            inputClosed = true;
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // Preserve an early old-entry rejection as data. Its real exit and
            // both drains still have to join; no successful write is invented.
            inputWriteFailure = Program.Error(error);
            try { child.Input.Close(); inputClosed = true; } catch (Exception closeError) when (closeError is IOException or ObjectDisposedException) { }
        }
        await child.JoinAsync(token);
        var after = ReaderFiles();
        Values["reader"] = new { variant, originalExecutionId, requestUtf8Base64 = Convert.ToBase64String(bytes), args, inputClosed, inputWriteFailure, helper = child.Evidence(), stdoutText = child.Output!.OriginalText, stderrText = child.Error!.OriginalText, before, after };
        Program.Require(!child.Forced && Program.Equal(before, after), "reader_changed_original_journal_or_needed_force");
    }
    internal async Task JoinEnginesAsync(CancellationToken token) { foreach (var pin in EnginePins) await pin.WaitAsync(token); }
    internal async Task FinishNaturalAsync(Session session, CancellationToken token)
    {
        await session.Subject.JoinAsync(token); await JoinEnginesAsync(token);
        Program.Require(session.Subject.Pin.ExitCode == 0 && !session.Subject.Forced, "ordinary_subject_did_not_naturally_exit0");
        await ReadbackAsync(session, token);
    }
    public async ValueTask DisposeAsync()
    {
        foreach (var bridge in bridges) await bridge.DisposeAsync();
        await Hub.DisposeAsync();
        CloseJobHandles();
        foreach (var actor in Actors) actor.Dispose();
        foreach (var child in DirectChildren) child.Dispose();
        foreach (var subject in Subjects) subject.Dispose();
        foreach (var pin in EnginePins) pin.Dispose();
    }
}

internal static class Harness
{
    internal static async Task<int> RunAsync(string ordinary, string test, string ordinaryDll, string directory, long deadlineTick, int cleanupMs)
    {
        using var self = ProcessPin.Open((uint)Environment.ProcessId);
        using var inputStop = new CancellationTokenSource();
        var commands = new Frames();
        var inputTask = Task.Run(async () =>
        {
            try
            {
                using var input = new StreamReader(Console.OpenStandardInput(), Program.Utf8, false, leaveOpen: true);
                while (await Program.ReadLineAsync(input, inputStop.Token) is { } line) commands.Add(Program.Parse(line));
                commands.End();
            }
            catch (Exception error) when (inputStop.IsCancellationRequested && error is OperationCanceledException or ObjectDisposedException) { }
            catch (Exception error) { commands.End(error); }
        });
        Program.Write(new { kind = "host-ready", identity = self.Identity, nonInherited = self.NonInherited, sameSid = self.SameSid, actorLaunches = 0 });
        using var execution = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, deadlineTick - Environment.TickCount64)));
        RunContext? run = null;
        object? setupFailure = null;
        object? failure = null;
        var cleanupFailures = new List<object>();
        string? scenario = null;
        try
        {
            var command = await commands.MatchAsync(value => value.TryGetProperty("scenario", out _), execution.Token);
            Program.Exact(command, "scenario"); scenario = Program.Text(command, "scenario");
            Program.Require(Path.IsPathFullyQualified(ordinary) && Path.IsPathFullyQualified(test) && Path.IsPathFullyQualified(ordinaryDll) && File.Exists(ordinary) && File.Exists(test) && File.Exists(ordinaryDll), "fixed_subject_artifacts_required");
            run = new(scenario, directory, ordinary, test, ordinaryDll, deadlineTick, commands);
            await run.MetadataAsync(checked((int)Math.Max(1, deadlineTick - Environment.TickCount64)), cleanupMs, execution.Token);
        }
        catch (Exception error) { setupFailure = Program.Error(error); }
        if (setupFailure is null)
        {
            try { await ScenarioAsync(run!, execution.Token); }
            catch (Exception error) { failure = Program.Error(error); }
        }
        var cleanupAt = Math.Min(Environment.TickCount64 + cleanupMs, deadlineTick + cleanupMs);
        Program.Write(new { kind = "host-cleanup-start", deadlineTick = cleanupAt });
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, cleanupAt - Environment.TickCount64)));
        if (run is not null)
        {
            if (failure is not null || setupFailure is not null)
            {
                foreach (var subject in run.Subjects) try { subject.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
                foreach (var engine in run.EnginePins.Where(pin => pin.Alive)) try { engine.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
                foreach (var actor in run.Actors) try { actor.Child.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
                foreach (var child in run.DirectChildren) try { child.Terminate(); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            }
            foreach (var subject in run.Subjects) try { await subject.JoinAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            foreach (var pin in run.EnginePins) try { await pin.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            foreach (var actor in run.Actors) try { await actor.ExitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
            foreach (var child in run.DirectChildren) try { await child.JoinAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        }
        inputStop.Cancel();
        try { await inputTask.WaitAsync(cleanup.Token); } catch (Exception error) { cleanupFailures.Add(Program.Error(error)); }
        var allJoined = run is null || run.Subjects.All(subject => subject.Pin.Joined && subject.Output.Eof && subject.Error.Eof) && run.EnginePins.All(pin => pin.Joined && !pin.Alive) && run.Actors.All(actor => actor.Child.OriginalJoined && actor.Child.Output!.Eof && actor.Child.Error!.Eof) && run.DirectChildren.All(child => child.OriginalJoined && child.Output!.Eof && child.Error!.Eof);
        var receipt = new { scenario, setupFailure, failure, values = run?.Values ?? [], actors = run?.Actors.Select(actor => actor.Child.Evidence()).Concat(run.DirectChildren.Select(child => child.Evidence())).ToArray() ?? [], subjects = run?.Subjects.Select(subject => subject.Evidence()).ToArray() ?? [], engineProcesses = run?.EnginePins.Select(pin => pin.Evidence()).ToArray() ?? [], cleanup = new { failures = cleanupFailures, originalRegistry = true, allObservedJoined = allJoined } };
        if (run is not null) await run.DisposeAsync();
        Program.Write(new { kind = "receipt", value = receipt });
        return cleanupFailures.Count == 0 ? 0 : 1;
    }
    private static Task ScenarioAsync(RunContext run, CancellationToken token) => run.Scenario switch
    {
        "C0" => ControlAsync(run, token),
        "legacy-red" => LegacyRedAsync(run, token),
        "prepared-ts" or "prepared-raw" => PreparedAsync(run, token),
        "prepare-diagnostic-installation-denied" or "prepare-diagnostic-reservation-denied" => PrepareDiagnosticScenarios.RunAsync(run, token),
        "ordinary-once" or "observer-eof" or "capacity-drains" or "parent-first" or "long-deadline-grace" => OrdinaryAsync(run, token),
        "conflicts" => ConflictsAsync(run, token),
        "auth-before-resume-owner-eof" or "auth-before-resume-controller-exit" or "auth-writing-owner-eof" or "running-owner-eof" => LossAsync(run, token),
        "stop-before-prepare" or "stop-prepared" or "stop-running" or "deadline-before-prepare" or "deadline-before-resume" => StopDeadlineAsync(run, token),
        "business-late-soft" or "business-force-first" or "business-rejections" or "deadline-business-force-wake" or "deadline-business-soft-wake" or "deadline-business-later-soft" or "business-loss-reject" => BusinessStopAsync(run, token),
        "session-count2" => Count2SessionAsync(run, token),
        "legacy-count2" => Count2LegacyAsync(run, token),
        "force-denied" or "closed-original-job" or "prepare-no-receipt" or "prepare-no-receipt-slow-diagnostic" => UnknownRetentionAsync(run, token),
        "drain-failure" => DrainFailureAsync(run, token),
        "crash-auth-before-resume" or "crash-resume-before-ack" => CrashAsync(run, token),
        var scenario when scenario.StartsWith("runtime-observation-", StringComparison.Ordinal) => RuntimeObservationScenarios.RunAsync(run, token),
        var scenario when scenario.StartsWith("reader-", StringComparison.Ordinal) => ReaderAsync(run, token),
        var scenario when scenario.StartsWith("io-", StringComparison.Ordinal) => JournalFaultAsync(run, token),
        _ => throw new InvalidDataException("unknown_frozen_session_scenario")
    };
    private static async Task ReaderAsync(RunContext run, CancellationToken token)
    {
        if (run.Scenario == "reader-interrupted")
        {
            await LossAsync(run, token);
            var interruptedSubject = run.Subjects.Single();
            run.Values["readerSource"] = new { kind = "original-interrupted-chain", writerClosed = true, originalExecutionId = interruptedSubject.ExecutionId, intentionalCrash = false };
            await run.ReadRecoveryAsync(interruptedSubject.ExecutionId!, "valid", true, token);
            return;
        }
        if (run.Scenario is "reader-empty" or "reader-reservation")
        {
            var originalExecutionId = Guid.NewGuid().ToString("N");
            if (run.Scenario == "reader-reservation")
            {
                var reserved = ProtectedJournal.Reserve(run.RecordsRoot, run.Scope, originalExecutionId);
                using var writer = reserved.Owner;
                Program.Require(reserved.Status == JournalStatus.Created && writer is not null, "reader_original_reservation_setup");
            }
            run.Values["readerSource"] = new { kind = run.Scenario, writerClosed = true, originalExecutionId, intentionalCrash = false };
            await run.ReadRecoveryAsync(originalExecutionId, "valid", true, token);
            return;
        }
        if (run.Scenario is "reader-live" or "reader-partial-prepared" or "reader-partial-auth")
        {
            var auth = run.Scenario == "reader-partial-auth";
            var session = await run.SessionAsync(token, plan: auth ? new("auth", "AuthVerifiedBeforeResumeGate", "None") : null);
            var descriptor = await run.PrepareAsync(session, token);
            var originalEngine = run.PinFact(descriptor.GetProperty("details").GetProperty("engine")); await run.RegisterAsync(originalEngine, token);
            Program.Require(!File.Exists(run.Marker) && originalEngine.Alive && session.Subject.Pin.Alive, "reader_original_prepared_source");
            if (run.Scenario == "reader-live")
            {
                run.Values["readerSource"] = new { kind = run.Scenario, writerClosed = false, helperLive = session.Subject.Pin.Alive, originalEngineLive = originalEngine.Alive, firstActionAbsent = !File.Exists(run.Marker), originalExecutionId = session.Subject.ExecutionId, intentionalCrash = false };
                await run.ReadRecoveryAsync(session.Subject.ExecutionId!, "valid", false, token);
                run.Values["readerAfterLive"] = new { helperLive = session.Subject.Pin.Alive, originalEngineLive = originalEngine.Alive, firstActionAbsent = !File.Exists(run.Marker) };
                await run.ExchangeAsync(session, "stop", token); await run.FinishNaturalAsync(session, token);
                return;
            }
            JsonElement? stage = null;
            if (auth)
            {
                await run.SendFrameAsync(session, run.BindOriginalAuthorize(session, descriptor), token);
                stage = await session.Bridge!.ReachedAsync(token);
                Program.Require(File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId)) && !File.Exists(run.Marker), "reader_auth_partial_original_gate");
            }
            run.CloseJobHandles(); session.Subject.Terminate(); await session.Subject.JoinAsync(token); await run.JoinEnginesAsync(token);
            if (auth) Program.Require(!await run.ObserveAuthorizeAckAsync(session, token), "reader_partial_auth_cannot_invent_ack");
            Program.Require(!File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId)), "reader_crash_source_cannot_have_terminal");
            await run.ReadbackAsync(session, token);
            run.Values["readerSource"] = new { kind = run.Scenario, writerClosed = true, originalExecutionId = session.Subject.ExecutionId, intentionalCrash = session.Subject.Forced, originalEngineJoined = originalEngine.Joined, originalStage = stage, firstActionAbsent = !File.Exists(run.Marker), terminalAbsent = true };
            await run.ReadRecoveryAsync(session.Subject.ExecutionId!, "valid", true, token);
            return;
        }
        await OrdinaryAsync(run, token);
        var original = run.Subjects.Single();
        Program.Require(original.Pin.Joined && !original.Pin.Alive && !original.Forced, "reader_health_requires_original_writer_closed");
        var readback = Program.Element(run.Values["readback"]);
        var strict = readback.GetProperty("strict");
        Program.Require(Program.Text(strict.GetProperty("reservation"), "status") == "Existing" && new[] { Readback.RequestId, Readback.PreparedId, Readback.AuthId, Readback.TerminalId }.All(slot => Program.Text(strict.GetProperty("records").GetProperty(slot), "status") == "Existing") && Program.Text(strict.GetProperty("records").GetProperty(Readback.LossId), "status") == "Unknown", "reader_direct_strict_health_control_failed");
        run.Values["readerSource"] = new { kind = "ordinary-engine-exit", writerClosed = true, originalExecutionId = original.ExecutionId, intentionalCrash = false, directStrictHealthy = true, noLossSlot = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.LossId)) };
        if (run.Scenario == "reader-healthy") Probe.CreateFile(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.ReservedId), new byte[] { 0xff });
        if (run.Scenario == "reader-raw-bad-record" || run.Scenario.StartsWith("reader-record-", StringComparison.Ordinal))
        {
            var path = Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.RequestId);
            var before = Program.Element(Probe.FileEvidence(path, includeBytes: true));
            var envelope = JsonNode.Parse(File.ReadAllBytes(path))!.AsObject();
            if (run.Scenario == "reader-raw-bad-record") envelope["record"] = new JsonObject { ["recordId"] = Readback.RequestId, ["kind"] = "not-a-session-record", ["unexpected"] = true };
            if (run.Scenario == "reader-record-root-id") envelope["rootIdentity"]!["fileId"] = new string('0', 32);
            if (run.Scenario == "reader-record-marker-id") envelope["reservationIdentity"]!["fileId"] = new string('0', 32);
            if (run.Scenario == "reader-record-file-id") envelope["fileIdentity"]!["fileId"] = new string('0', 32);
            var text = envelope.ToJsonString(Program.Json);
            if (run.Scenario == "reader-record-duplicate") text = text.Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal);
            if (run.Scenario == "reader-record-truncated") text = text[..^1];
            var bytes = run.Scenario == "reader-record-bad-utf8" ? new byte[] { 0xff } : Program.Utf8.GetBytes(text);
            Probe.ReplaceOwnBytes(path, bytes);
            var after = Program.Element(Probe.FileEvidence(path, includeBytes: true));
            Program.Require(JsonElement.DeepEquals(before.GetProperty("identity"), after.GetProperty("identity")), "reader_fixture_mutation_replaced_original_file");
            run.Values["readerSourceMutation"] = new { leaf = Path.GetFileName(path), before, after, sameOriginalFile = true };
        }
        var variant = run.Scenario.StartsWith("reader-input-", StringComparison.Ordinal) ? run.Scenario["reader-input-".Length..] : run.Scenario switch { "reader-wrong-scope" => "wrong-scope", "reader-wrong-id" => "wrong-id", _ => "valid" };
        await run.ReadRecoveryAsync(original.ExecutionId!, variant, true, token);
    }
    private static async Task ControlAsync(RunContext run, CancellationToken token)
    {
        var before = run.Bundle.Snapshot();
        var loaded = typeof(ProtectedJournal).Assembly;
        Program.Require(Program.Hash(File.ReadAllBytes(loaded.Location)) == Program.Hash(File.ReadAllBytes(run.OrdinaryDll)), "fixture_reference_is_fixed_ordinary_artifact");
        var types = loaded.GetTypes();
        var names = types.Where(type => type.Name.Contains("TestControl", StringComparison.Ordinal) || type.Name.Contains("TestStage", StringComparison.Ordinal) || type.Name.Contains("TestFault", StringComparison.Ordinal) || type.Name.Contains("PrepareFailurePoint", StringComparison.Ordinal)).Select(type => type.FullName).Order(StringComparer.Ordinal).ToArray();
        var members = types.SelectMany(type => type.GetMembers(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)).Where(member => member.Name.Contains("ForTest", StringComparison.Ordinal) || member.Name.Contains("TestHook", StringComparison.Ordinal)).Select(member => member.DeclaringType!.FullName + "." + member.Name).Distinct().Order(StringComparer.Ordinal).ToArray();
        Program.Require(names.Length == 0 && members.Length == 0, "ordinary_assembly_exposes_test_hooks");
        var engine = new Child(run.Bundle.Binary, run.Directory, run.Bundle.Arguments(run.InputPath, run.OutputPath));
        run.DirectChildren.Add(engine); engine.Start(); await run.RegisterAsync(engine.Pin!, token);
        var peer = await run.Hub.PeerAsync("engine", token);
        Program.Require(peer.Pin.Identity == engine.Pin!.Identity && File.Exists(run.Marker), "direct_engine_original_first_action");
        await peer.ReleaseAsync("finish", token); await engine.JoinAsync(token);
        var after = run.Bundle.Snapshot();
        Program.Require(engine.Pin.ExitCode == 0 && !engine.Forced && Program.Equal(before, after), "independent_control_must_be_healthy");
        run.Values["control"] = new { firstActionCreated = true, originalEngineJoined = engine.OriginalJoined, stdoutEof = engine.Output!.Eof, stderrEof = engine.Error!.Eof, forced = engine.Forced, exitCode = engine.Pin.ExitCode, strictUtf8 = engine.Output.Error is null && engine.Error.Error is null, recipeExact = true, sameSid = engine.Pin.SameSid, manifestClosureDeclared = true, stdout = engine.Output.Lines, stderr = engine.Error.Lines, ordinaryTestOnlyTypes = names, ordinaryTestOnlyMembers = members, publishFiles = run.Bundle.PublishFiles, bundleBefore = before, bundleAfter = after, actualPeer = peer.Pin.Identity, ordinaryAssemblySha256 = Program.Hash(File.ReadAllBytes(loaded.Location)) };
    }
    private static async Task LegacyRedAsync(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token, legacy: true);
        var inspect = await run.ExchangeAsync(session, "inspect", token);
        Program.Require(Program.Text(inspect, "kind") == "response" && Program.Text(inspect.GetProperty("state"), "phase") == "claimed", "legacy_healthy_transport_control");
        run.Values["baselineTransportHealthy"] = true;
        run.Values["legacyInspect"] = inspect;
        run.Values["legacyOriginalBindings"] = new { helper = session.Subject.Pin.Identity, controller = session.Controller.Child.Pin!.Identity, observer = session.Observer.Child.Pin!.Identity };
        var request = run.PrepareRequest(session);
        Program.Exact(request, "v", "requestId", "op", "executionId", "requestUtf8Base64", "requestFingerprint");
        run.Values["legacyPrepareRequest"] = request;
        await run.SendFrameAsync(session, request, token);
        run.Values["legacyPrepareWriteCompleted"] = true;
        // The legacy writer can be canceled after enqueueing invalid_request.
        // Join the actual original reader; never translate arbitrary read errors.
        var closed = await session.Controller.CallAsync("wait-closed", new { key = "owner" }, token);
        run.Values["legacyOwnerClosed"] = closed;
        Program.Require(closed.GetProperty("actualEof").GetBoolean() && !closed.GetProperty("localClose").GetBoolean() && closed.GetProperty("readerError").ValueKind == JsonValueKind.Null, "legacy_owner_not_true_remote_eof");
        var ownerConnection = closed.GetProperty("connection");
        Program.Require(JsonElement.DeepEquals(ownerConnection.GetProperty("server"), Program.Element(session.Subject.Pin.Identity)) && JsonElement.DeepEquals(ownerConnection.GetProperty("client"), Program.Element(session.Controller.Child.Pin.Identity)), "legacy_owner_original_binding_changed");
        var sent = closed.GetProperty("sent").EnumerateArray().Where(frame => Program.Text(frame, "requestId") == Program.Text(request, "requestId")).ToArray();
        Program.Require(sent.Length == 1 && JsonElement.DeepEquals(sent[0], request), "legacy_original_prepare_not_sent");
        var replies = closed.GetProperty("rawFrames").EnumerateArray().Select(line => Program.Parse(line.GetString()!)).Where(frame => frame.TryGetProperty("requestId", out var id) && (id.ValueKind == JsonValueKind.String && id.GetString() == Program.Text(request, "requestId") || id.ValueKind == JsonValueKind.Null && Program.Text(frame, "kind") == "error")).ToArray();
        Program.Require(replies.Length <= 1, "legacy_multiple_prepare_replies");
        if (replies.Length == 1)
        {
            var actual = replies[0];
            Program.Require(Program.Text(actual, "kind") == "error" && Program.Text(actual, "code") == "invalid_request", "legacy_prepare_not_rejected");
            run.Values["actualPrepare"] = actual;
        }
        else run.Values["actualPrepare"] = Program.Element(new { kind = "owner-eof", owner = closed });
        var sealedEvent = await run.EventAsync(session, "phase", "sealed", token);
        run.Values["legacySealedEvent"] = sealedEvent;
        var sealedInspect = await run.ExchangeAsync(session, "inspect", token, observer: true);
        run.Values["legacySealedInspect"] = sealedInspect;
        var observer = await session.Observer.CallAsync("snapshot", new { key = "observer" }, token);
        run.Values["legacyObserverSnapshot"] = observer;
        foreach (var frame in new[] { sealedEvent, sealedInspect })
        {
            var state = frame.GetProperty("state");
            Program.Exact(state, "phase", "sealReason");
            Program.Require(Program.Text(frame, "executionId") == session.Subject.ExecutionId && Program.Text(state, "phase") == "sealed" && Program.Text(state, "sealReason") == "owner_eof", "legacy_observer_did_not_prove_owner_seal");
        }
        var observerConnection = observer.GetProperty("connection");
        Program.Require(JsonElement.DeepEquals(observerConnection.GetProperty("server"), Program.Element(session.Subject.Pin.Identity)) && JsonElement.DeepEquals(observerConnection.GetProperty("client"), Program.Element(session.Observer.Child.Pin.Identity)), "legacy_observer_original_binding_changed");
        run.Values["legacyHelperBeforeContainment"] = session.Subject.Pin.Evidence();
        Program.Require(session.Subject.Pin.Alive, "legacy_original_helper_not_live_before_containment");
        run.Values["behavioralRejectionObservedBeforeContainment"] = true;
        // The old control-only helper is intentionally resident. This planned
        // containment happens after the behavior has already been recorded.
        run.Values["subjectCleanupMode"] = "legacy-explicit-containment";
        session.Subject.Terminate(); await session.Subject.JoinAsync(token);
        run.Values["subjectForced"] = session.Subject.Forced;
        Program.Require(session.Subject.Forced && run.Values["behavioralRejectionObservedBeforeContainment"] is true, "legacy_red_not_an_observed_behavioral_rejection");
    }
    private static async Task PreparedAsync(RunContext run, CancellationToken token)
    {
        run.Values["leaseBefore"] = run.Bundle.MutableModels();
        run.Values["bundleBefore"] = run.Bundle.Snapshot();
        var session = await run.SessionAsync(token);
        var descriptor = await run.PrepareAsync(session, token);
        await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
        run.Values["preparedProbe"] = run.PreparedProbe(descriptor);
        run.Values["leaseHeld"] = run.Bundle.MutableModels();
        if (run.Scenario == "prepared-ts") await session.Controller.CallAsync("close", new { key = "owner" }, token);
        else await run.ExchangeAsync(session, "stop", token);
        await run.FinishNaturalAsync(session, token);
        run.Values["leaseAfter"] = run.Bundle.MutableModels();
        run.Values["bundleAfter"] = run.Bundle.Snapshot();
    }
    private static async Task<(JsonElement Descriptor, EnginePeer Peer)> AuthorizeAsync(RunContext run, Session session, CancellationToken token)
    {
        var descriptor = await run.PrepareAsync(session, token);
        await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
        var request = run.BindOriginalAuthorize(session, descriptor);
        var ack = await run.ExchangeFrameAsync(session, request, token);
        run.Values["authorize"] = ack;
        Program.Require(Program.Text(ack, "kind") == "response" && Program.Text(ack.GetProperty("state"), "resumeState") == "succeeded", "actual_original_resume_not_acknowledged");
        var peer = await run.PeerAsync("engine", descriptor, token);
        run.Values["firstAction"] = new { markerCreated = File.Exists(run.Marker), engine = peer.Pin.Identity, engineInOriginalJob = true, helperAcknowledgedBeforeFinish = true };
        return (descriptor, peer);
    }
    private static async Task OrdinaryAsync(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        var (descriptor, peer) = await AuthorizeAsync(run, session, token);
        if (run.Scenario == "ordinary-once")
        {
            run.Values["authorizeReplay"] = await run.ExchangeFrameAsync(session, run.AuthorizeRequest(session, descriptor), token);
            run.Values["prepareReplay"] = await run.ExchangeFrameAsync(session, run.PrepareRequest(session), token);
        }
        else if (run.Scenario == "observer-eof")
        {
            run.Values["observerClosed"] = await session.Observer.CallAsync("close", new { key = "observer" }, token);
            run.Values["afterObserverClose"] = (await run.ExchangeAsync(session, "inspect", token)).GetProperty("state").Clone();
        }
        else if (run.Scenario == "capacity-drains")
        {
            await peer.ReleaseAsync("capacity-write", token);
            run.Values["capacityDrains"] = await peer.StageAsync("capacity-complete", token);
        }
        else if (run.Scenario == "long-deadline-grace")
        {
            var stop = await run.ExchangeAsync(session, "stop", token);
            run.Values["longDeadlineGrace"] = new { originalDeadline = run.Spec.GetProperty("executionDeadlineAt").GetInt64(), originalGrace = run.Spec.GetProperty("executionPolicy").GetProperty("limits").GetProperty("cancelGraceMs").GetInt64(), stop, firstActionAlreadyCreated = File.Exists(run.Marker) };
        }
        else if (run.Scenario == "parent-first")
        {
            await peer.ReleaseAsync("spawn-child", token);
            var childCreated = await peer.StageAsync("child-created", token);
            var child = await run.PeerAsync("child", descriptor, token);
            Program.Require(child.Pin.Identity == childCreated.GetProperty("child").Deserialize<ProcessFact>(Program.Json), "original_child_creation_binding");
            await child.ReleaseAsync("spawn-grandchild", token);
            var grandchildCreated = await child.StageAsync("grandchild-created", token);
            var grandchild = await run.PeerAsync("grandchild", descriptor, token);
            Program.Require(grandchild.Pin.Identity == grandchildCreated.GetProperty("child").Deserialize<ProcessFact>(Program.Json), "original_grandchild_creation_binding");
            await peer.ReleaseAsync("finish", token); await peer.Pin.WaitAsync(token);
            var job = run.OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"));
            var active = Probe.JobAccounting(job).ActiveProcesses;
            var absent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId));
            run.Values["parentFirst"] = new { originalParentSignaled = !peer.Pin.Alive, originalDescendantsLive = child.Pin.Alive && grandchild.Pin.Alive, activeProcesses = active, terminalAbsent = absent, helperStillLive = session.Subject.Pin.Alive, stdoutWriterRetained = true, stderrWriterRetained = true, child = child.Pin.Identity, grandchild = grandchild.Pin.Identity, actualChildStdoutCapacity = child.Hello.GetProperty("stdoutCapacity"), actualGrandchildStderrCapacity = grandchild.Hello.GetProperty("stderrCapacity") };
            Program.Require(active == 2 && absent && session.Subject.Pin.Alive && child.Pin.Alive && grandchild.Pin.Alive, "parent_exit_is_not_original_tree_or_dual_eof");
            await child.ReleaseAsync("finish", token); await child.Pin.WaitAsync(token);
            await grandchild.ReleaseAsync("finish", token); await grandchild.Pin.WaitAsync(token);
            await run.FinishNaturalAsync(session, token); return;
        }
        await peer.ReleaseAsync("finish", token);
        await run.FinishNaturalAsync(session, token);
    }
    private static async Task ConflictsAsync(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token);
        var conflicts = new List<object>();
        async Task Check(JsonElement request, string code, bool observer = false)
        {
            var actual = await run.ExchangeFrameAsync(session, request, token, observer);
            Program.Require(Program.Text(actual, "kind") == "error" && Program.Text(actual, "code") == code, "wrong_conflict_response");
            conflicts.Add(new { expectedCode = code, actual });
        }
        await Check(run.Request("prepare", Guid.NewGuid().ToString("N"), run.Carrier), "scope_mismatch");
        await Check(run.Request("claim", session.Subject.ExecutionId!), "controller_mismatch", true);
        await Check(run.PrepareRequest(session), "not_owner", true);
        var placeholder = Program.Element(new { adapterId = "windows-supervisor-v1", launchTicket = run.Scope.Target.LaunchTicket, executionId = session.Subject.ExecutionId, details = new { v = 1, target = run.Scope.Target, executionPolicyFingerprint = run.Scope.ExecutionPolicyFingerprint, requestFingerprint = Program.Text(run.Carrier, "requestFingerprint"), requestRecordId = Readback.RequestId, preparedRecordId = Readback.PreparedId, recipeId = "upscayl-4x-png-v1", installationManifestSha256 = run.Bundle.ManifestSha256, supervisor = session.Subject.Pin.Identity, engine = session.Controller.Child.Pin!.Identity, jobName = @"Local\Fixture-authorization-before-prepare" } });
        await Check(run.AuthorizeRequest(session, placeholder), "not_prepared");
        await session.Controller.CallAsync("open", new { key = "second-owner", leaf = session.Leaf, expected = session.Subject.Pin.Identity, executionId = session.Subject.ExecutionId }, token);
        var second = await session.Controller.CallAsync("exchange", new { key = "second-owner", request = run.Request("claim", session.Subject.ExecutionId!) }, token);
        Program.Require(Program.Text(second, "code") == "owner_already_claimed", "unique_original_owner_connection");
        conflicts.Add(new { expectedCode = "owner_already_claimed", actual = second });
        var descriptor = await run.PrepareAsync(session, token);
        await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
        var before = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
        var changed = JsonNode.Parse(run.Spec.GetRawText())!.AsObject(); changed["outputPath"] = run.OutputPath + ".changed";
        var changedBytes = Program.Utf8.GetBytes(changed.ToJsonString(Program.Json));
        await Check(run.Request("prepare", session.Subject.ExecutionId!, new { requestUtf8Base64 = Convert.ToBase64String(changedBytes), requestFingerprint = Program.Hash(changedBytes) }), "payload_conflict");
        var wrongDescriptor = JsonNode.Parse(descriptor.GetRawText())!.AsObject(); wrongDescriptor["details"]!["jobName"] = "wrong-original-job";
        await Check(run.AuthorizeRequest(session, Program.Element(wrongDescriptor)), "authorization_mismatch");
        var invalidRequest = run.Request("inspect", session.Subject.ExecutionId!);
        var invalid = invalidRequest.GetRawText().Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal) + "\n";
        await session.Controller.CallAsync("write-raw", new { key = "owner", text = invalid }, token);
        var invalidReply = await session.Controller.CallAsync("response", new { key = "owner", requestId = Program.Text(invalidRequest, "requestId"), acceptNull = true }, token);
        Program.Require(Program.Text(invalidReply, "code") == "invalid_request", "complete_invalid_owner_frame_rejected");
        conflicts.Add(new { expectedCode = "invalid_request", actual = invalidReply });
        var inspected = await run.ExchangeAsync(session, "inspect", token);
        run.Values["afterInvalidOwnerInspect"] = inspected;
        Program.Require(Program.Text(inspected.GetProperty("state"), "phase") == "prepared" && inspected.GetProperty("state").GetProperty("sealReason").ValueKind == JsonValueKind.Null, "invalid_frame_must_not_fabricate_owner_eof");
        var after = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
        run.Values["conflicts"] = conflicts;
        run.Values["firstActionAbsent"] = !File.Exists(run.Marker);
        run.Values["originalDescriptorUnchanged"] = JsonElement.DeepEquals(inspected.GetProperty("state").GetProperty("descriptor"), descriptor);
        run.Values["originalRecordsUnchanged"] = Program.Equal(before, after);
        var job = run.OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"));
        run.Values["originalEngineCount"] = Probe.JobAccounting(job).TotalProcesses;
        var authorize = await run.ExchangeFrameAsync(session, run.AuthorizeRequest(session, descriptor), token);
        run.Values["afterInvalidOwnerAuthorize"] = authorize;
        Program.Require(Program.Text(authorize, "kind") == "response" && Program.Text(authorize.GetProperty("state"), "resumeState") == "succeeded", "valid_authorize_after_invalid_complete_frame");
        var peer = await run.PeerAsync("engine", descriptor, token); await peer.ReleaseAsync("finish", token); await run.FinishNaturalAsync(session, token);
    }
    private static async Task JournalFaultAsync(RunContext run, CancellationToken token)
    {
        var names = run.Scenario.Split('-');
        Program.Require(names.Length == 3 && names[1] is "request" or "prepared" or "auth" && names[2] is "WriteReadOnly" or "FlushReadOnly" or "RenameCollision", "frozen_journal_fault");
        var slot = names[1]; var fault = names[2];
        var stageName = fault switch { "WriteReadOnly" => "BeforeWrite", "FlushReadOnly" => "BeforeFlush", _ => "RecordFlushed" };
        var session = await run.SessionAsync(token, plan: new(slot, stageName, fault == "RenameCollision" ? "None" : fault));
        JsonElement request;
        if (slot == "auth")
        {
            var descriptor = await run.PrepareAsync(session, token);
            await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
            request = run.AuthorizeRequest(session, descriptor);
        }
        else request = run.PrepareRequest(session);
        await run.SendFrameAsync(session, request, token);
        var stage = await session.Bridge!.ReachedAsync(token);
        var engine = run.PinStage(stage);
        if (engine is not null) await run.RegisterAsync(engine, token);
        run.Values["faultStage"] = stage;
        var slotId = slot switch { "request" => Readback.RequestId, "prepared" => Readback.PreparedId, _ => Readback.AuthId };
        var path = Readback.RecordPath(run.RecordsRoot, run.Scope, slotId);
        if (fault == "RenameCollision")
        {
            Program.Require(!File.Exists(path), "collision_target_must_not_exist");
            using var root = Probe.OpenFile(run.RecordsRoot);
            using var marker = Probe.OpenFile(Path.Combine(run.RecordsRoot, Readback.Key(run.Scope) + ".reserved"));
            Probe.CreateFile(path, []);
            using (var target = Probe.OpenFile(path))
            {
                var envelope = new { v = 1, kind = "record", scope = run.Scope, executionId = session.Subject.ExecutionId, recordId = slotId, rootIdentity = Probe.FileIdentity(root), reservationIdentity = Probe.FileIdentity(marker), fileIdentity = Probe.FileIdentity(target), record = new { v = 1, kind = "fixture-collision", recordId = slotId } };
                Probe.ReplaceOwnBytes(path, JsonSerializer.SerializeToUtf8Bytes(envelope, Program.Json));
            }
            run.Values["collisionBefore"] = new { present = true, file = Probe.FileEvidence(path) };
        }
        else run.Values["ioProbe"] = session.Bridge.ProbeJournal(stage);
        Program.Require(!File.Exists(run.Marker), "journal_fault_must_precede_resume");
        await session.Bridge.ReleaseAsync(token);
        await session.Subject.JoinAsync(token);
        await run.JoinEnginesAsync(token);
        // No final ACK/event is required: delivery is not a durable outcome.
        // The actual failed I/O/collision, original process/EOF facts and raw
        // slots remain the oracle even if shutdown drops a last notification.
        var before = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
        var terminalAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId));
        Program.Require(terminalAbsent && !File.Exists(run.Marker), "uncertain_publication_created_resume_or_terminal");
        var repeatSession = await run.SessionAsync(token);
        var repeated = run.PrepareRequest(repeatSession); await run.SendFrameAsync(repeatSession, repeated, token);
        await repeatSession.Subject.JoinAsync(token);
        var after = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
        run.Values["replayDidNotChangeEvidence"] = Program.Equal(before, after);
        run.Values["unknownObserved"] = true;
        run.Values["unknownBasis"] = "actual-failed-original-publication-and-no-complete-terminal";
        run.Values["firstActionAbsent"] = !File.Exists(run.Marker);
        run.Values["terminalAbsent"] = terminalAbsent;
        if (fault == "RenameCollision") run.Values["collisionAfter"] = new { present = File.Exists(path), file = Probe.FileEvidence(path) };
        await run.ReadbackAsync(session, token);
    }
    private static async Task LossAsync(RunContext run, CancellationToken token)
    {
        var running = run.Scenario == "running-owner-eof";
        var plan = running ? null : run.Scenario == "auth-writing-owner-eof" ? new BridgePlan("auth", "RecordWritten", "None") : new BridgePlan("auth", "AuthVerifiedBeforeResumeGate", "None");
        var session = await run.SessionAsync(token, plan: plan);
        JsonElement descriptor;
        if (running)
        {
            var authorized = await AuthorizeAsync(run, session, token); descriptor = authorized.Descriptor;
        }
        else
        {
            descriptor = await run.PrepareAsync(session, token);
            await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
            await run.SendFrameAsync(session, run.BindOriginalAuthorize(session, descriptor), token);
            var stage = await session.Bridge!.ReachedAsync(token); run.Values["lossStage"] = stage;
            Program.Require(!File.Exists(run.Marker), "pre_resume_loss_first_action_must_be_absent");
        }
        var originalJob = run.OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"));
        SafeFileHandle? retainedOwnerPipe = null;
        try
        {
            if (run.Scenario == "auth-before-resume-controller-exit")
            {
                // Keep this exact original owner pipe object open in the
                // fixture so actual controller process signal wins over EOF.
                var retained = await session.Controller.CallAsync("retain-pipe", new { key = "owner" }, token);
                retainedOwnerPipe = new SafeFileHandle(Probe.Pointer(Program.Text(retained, "handle")), true);
                Program.Require(Probe.NonInherited(retainedOwnerPipe), "retained_owner_pipe_noninherit");
                await session.Controller.ExitUntilSignaledAsync(token);
                Program.Require(session.Controller.Child.Pin!.Joined && session.Controller.Child.Pin.ExitCode == 0 && !session.Controller.Child.Forced, "original_controller_did_not_naturally_signal_exit0");
            }
            else await session.Controller.CallAsync("close", new { key = "owner" }, token);
            var reason = run.Scenario == "auth-before-resume-controller-exit" ? "controller_exit" : "controller_eof";
            var observed = await run.EventAsync(session, "sealReason", reason, token);
            run.Values["actualLossObservedBeforeRelease"] = Program.Text(observed.GetProperty("state"), "sealReason") == reason;
            run.Values["lossObserved"] = observed;
            if (session.Bridge is not null) await session.Bridge.ReleaseAsync(token);
        }
        finally { retainedOwnerPipe?.Dispose(); }
        if (run.Scenario == "auth-before-resume-controller-exit") await session.Controller.Child.JoinAsync(token);
        await run.FinishNaturalAsync(session, token);
        var accounting = Probe.JobAccounting(originalJob);
        run.Values["engineTreeExited"] = run.EnginePins.All(pin => pin.Joined && !pin.Alive);
        run.Values["activeProcesses"] = accounting.ActiveProcesses;
        run.Values["firstActionAbsent"] = !File.Exists(run.Marker);
        var successAuthorizeAck = await run.ObserveAuthorizeAckAsync(session, token);
        run.Values["successAuthorizeAck"] = successAuthorizeAck;
        Program.Require(successAuthorizeAck == running, "loss_original_received_authorize_ack_mismatch");
        var authPath = Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.AuthId);
        run.Values["authorizationVerified"] = File.Exists(authPath);
    }
    private static async Task BusinessStopAsync(RunContext run, CancellationToken token)
    {
        bool deadlineWake = run.Scenario.StartsWith("deadline-business-", StringComparison.Ordinal);
        var session = await run.SessionAsync(token, plan: new("terminal", deadlineWake ? "GraceWaiting" : "BeforeForce", "None"), fixtureStopGate: true);
        var rejectedCodes = new List<string>();
        JsonElement descriptor = default;
        long grace = run.Spec.GetProperty("executionPolicy").GetProperty("limits").GetProperty("cancelGraceMs").GetInt64();
        JsonElement Stop(string mode, long start, long end, JsonElement? target = null, JsonElement? owner = null, string? executionId = null) =>
            run.Request("request-stop", executionId ?? session.Subject.ExecutionId!, new { target = target ?? Program.Element(run.Scope.Target),
                descriptor = owner ?? descriptor, requestFingerprint = Program.Text(run.Carrier, "requestFingerprint"), mode, stopRequestedAt = start, terminateAfterAt = end });
        async Task Reject(JsonElement request, string code, bool observer = false)
        {
            var response = await run.ExchangeFrameAsync(session, request, token, observer);
            Program.Require(Program.Text(response, "kind") == "error" && Program.Text(response, "code") == code, "business_stop_expected_rejection");
            rejectedCodes.Add(code);
        }
        if (run.Scenario == "business-rejections")
        {
            descriptor = await run.PrepareAsync(session, token);
            await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
            long before = Program.Now;
            await Reject(Stop("soft", before, checked(before + grace)), "not_authorized");
            var auth = run.BindOriginalAuthorize(session, descriptor);
            var ack = await run.ExchangeFrameAsync(session, auth, token);
            Program.Require(Program.Text(ack.GetProperty("state"), "resumeState") == "succeeded", "business_stop_auth_required");
            run.Values["authorize"] = ack;
            await run.PeerAsync("engine", descriptor, token);
        }
        else descriptor = (await AuthorizeAsync(run, session, token)).Descriptor;
        var engine = run.PinFact(descriptor.GetProperty("details").GetProperty("engine"));
        run.CloseJobHandles();
        var proof = new Dictionary<string, object?> { ["extraEngineJobHandlesClosed"] = true };
        JsonElement accepted = default;
        if (run.Scenario == "business-loss-reject")
        {
            await session.Controller.CallAsync("close", new { key = "owner" }, token);
            await run.EventAsync(session, "sealReason", "controller_eof", token);
            var held = await session.Bridge!.ReachedAsync(token);
            long at = Program.Now - grace;
            var rejected = await run.ExchangeFrameAsync(session, Stop("soft", at, checked(at + grace)), token, observer: true);
            Program.Require(Program.Text(rejected, "kind") == "error" && Program.Text(rejected, "code") == "not_owner", "business_loss_original_owner_required");
            proof["rejected"] = rejected; proof["originalCause"] = Program.Text(held.GetProperty("observation"), "sealReason");
            await session.Bridge.ReleaseAsync(token);
        }
        else if (deadlineWake)
        {
            await run.EventAsync(session, "sealReason", "deadline", token);
            var registered = await session.Bridge!.ReachedAsync(token);
            proof["waitRegistration"] = registered;
            bool laterSoft = run.Scenario == "deadline-business-later-soft";
            if (laterSoft) await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(1, grace / 2)), token);
            long at = Program.Now, start = laterSoft ? at : checked(at - grace - 1), end = laterSoft ? checked(at + grace) : checked(at - 1), tick = Environment.TickCount64;
            accepted = await run.ExchangeFrameAsync(session, Stop(run.Scenario.EndsWith("force-wake", StringComparison.Ordinal) ? "force" : "soft", start, end), token);
            await session.Bridge.ReleaseAsync(token);
            await run.FinishNaturalAsync(session, token);
            proof["completedBeforeOldGrace"] = Environment.TickCount64 - tick < (laterSoft ? grace * 3 / 4 : grace / 2);
        }
        else
        {
            long start = checked(Program.Now - (run.Scenario == "business-force-first" ? grace + 1 : grace / 2)), end = checked(start + grace);
            if (run.Scenario == "business-rejections")
            {
                var assembly = typeof(PreparePayload).Assembly;
                var parse = assembly.GetType("Zeb.WindowsSupervisor.Program")!.GetMethod("ParseRequest", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
                string zero = Stop("soft", 0, grace).GetRawText();
                Program.Require(parse.Invoke(null, [zero, true]) is not null, "business_stop_canonical_zero_parser");
                int invalidTokensRejected = 0;
                foreach (string number in new[] { "-0", "-1", "0.0", "0e0", "9007199254740992", "\"0\"" })
                {
                    try { parse.Invoke(null, [zero.Replace("\"stopRequestedAt\":0", "\"stopRequestedAt\":" + number, StringComparison.Ordinal), true]); }
                    catch (System.Reflection.TargetInvocationException error) when (error.InnerException is InvalidDataException) { invalidTokensRejected++; }
                }
                var forceEligible = assembly.GetType("Zeb.WindowsSupervisor.NativeExecutionSession")!.GetMethod("ForceEligible", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
                bool equalForceRejected = !(bool)forceEligible.Invoke(null, [end, end])!, pastForceAccepted = (bool)forceEligible.Invoke(null, [checked(end + 1), end])!;
                Program.Require(invalidTokensRejected == 6 && equalForceRejected && pastForceAccepted, "business_stop_compiled_parser_boundaries");
                proof["compiledParser"] = new { source = "original-loaded-ordinary-assembly-parser", canonicalZeroAccepted = true, invalidTokensRejected, equalForceRejected, pastForceAccepted,
                    loadedAssemblySha256 = Program.Hash(File.ReadAllBytes(assembly.Location)) };
                await Reject(Stop("soft", start, end, executionId: Guid.NewGuid().ToString("N")), "scope_mismatch");
                var wrongTarget = Program.Element(new { identity = run.Scope.Target.Identity, launchTicket = "different-ticket" });
                await Reject(Stop("soft", start, end, target: wrongTarget), "authorization_mismatch");
                await Reject(Stop("soft", start, end), "not_owner", observer: true);
                await Reject(Stop("soft", start, checked(end + 1)), "invalid_stop");
                long future = checked(Program.Now + grace);
                await Reject(Stop("soft", future, checked(future + grace)), "early_stop");
                await Reject(Stop("force", start, end), "early_stop");
            }
            long sentTick = Environment.TickCount64;
            accepted = await run.ExchangeFrameAsync(session, Stop(run.Scenario == "business-force-first" ? "force" : "soft", start, end), token);
            if (run.Scenario == "business-late-soft")
            {
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(1, grace / 4)), token);
                proof["duplicateBeforeT"] = await run.ExchangeFrameAsync(session, Stop("soft", start, end), token);
            }
            var held = await session.Bridge!.ReachedAsync(token);
            proof["beforeForce"] = held;
            if (run.Scenario == "business-late-soft")
            {
                proof["beforeOriginalReceiptGrace"] = Environment.TickCount64 - sentTick < grace;
                if (Program.Now <= end) await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(0, end - Program.Now + 1)), token);
                Program.Require(Program.Now > end, "business_late_soft_after_original_T");
                proof["duplicateAfterT"] = await run.ExchangeFrameAsync(session, Stop("soft", start, end), token);
            }
            if (run.Scenario == "business-force-first")
            {
                proof["duplicateForce"] = await run.ExchangeFrameAsync(session, Stop("force", start, end), token);
                proof["softAfterForce"] = await run.ExchangeFrameAsync(session, Stop("soft", start, end), token);
            }
            if (run.Scenario == "business-rejections") await Reject(Stop("force", checked(start - 1), checked(end - 1)), "stop_conflict");
            await session.Bridge.ReleaseAsync(token);
        }
        if (!deadlineWake) await run.FinishNaturalAsync(session, token);
        if (run.Scenario != "business-loss-reject")
        {
            Program.Require(Program.Text(accepted, "kind") == "response" && Program.Text(accepted, "op") == "request-stop" &&
                Program.Text(accepted, "role") == "owner" && accepted.GetProperty("state").GetProperty("authorizationVerified").GetBoolean(), "business_stop_original_ack_required");
            proof["accepted"] = accepted;
        }
        proof["rejectedCodes"] = rejectedCodes; proof["originalEngineJoined"] = engine.Joined && !engine.Alive;
        run.Values["businessStop"] = proof;
    }

    private static async Task StopDeadlineAsync(RunContext run, CancellationToken token)
    {
        var beforePrepare = run.Scenario.EndsWith("before-prepare", StringComparison.Ordinal);
        var deadline = run.Scenario.StartsWith("deadline", StringComparison.Ordinal);
        var beforeResume = run.Scenario == "deadline-before-resume";
        var plan = beforePrepare ? new BridgePlan("request", "RecordVerified", "None") : beforeResume ? new BridgePlan("auth", "AuthVerifiedBeforeResumeGate", "None") : null;
        var session = await run.SessionAsync(token, plan: plan);
        if (beforePrepare)
        {
            await run.SendFrameAsync(session, run.PrepareRequest(session), token);
            run.Values["stopDeadlineStage"] = await session.Bridge!.ReachedAsync(token);
        }
        else if (run.Scenario == "stop-running") await AuthorizeAsync(run, session, token);
        else
        {
            var descriptor = await run.PrepareAsync(session, token);
            await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
            if (beforeResume)
            {
                await run.SendFrameAsync(session, run.AuthorizeRequest(session, descriptor), token);
                run.Values["stopDeadlineStage"] = await session.Bridge!.ReachedAsync(token);
            }
        }
        if (deadline)
        {
            var original = run.Spec.GetProperty("executionDeadlineAt").GetInt64();
            var expired = await run.EventAsync(session, "sealReason", "deadline", token);
            var observedAt = Program.Now;
            Program.Require(observedAt > original, "deadline_must_expire_strictly_after_original_value");
            run.Values["deadlineObservation"] = new { originalDeadline = original, observedAfterOriginalDeadline = observedAt > original, deadlineNotRebased = true, observedAt, actualEvent = expired };
        }
        else await run.ExchangeAsync(session, "stop", token);
        if (session.Bridge is not null) await session.Bridge.ReleaseAsync(token);
        await run.FinishNaturalAsync(session, token);
        run.Values["firstActionAbsent"] = !File.Exists(run.Marker);
    }
    private static async Task Count2SessionAsync(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token, plan: new("auth", "AuthVerifiedBeforeResumeGate", "AddPrimarySuspension"));
        var descriptor = await run.PrepareAsync(session, token);
        await run.RegisterAsync(run.PinFact(descriptor.GetProperty("details").GetProperty("engine")), token);
        var job = run.OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"));
        var request = run.BindOriginalAuthorize(session, descriptor); await run.SendFrameAsync(session, request, token);
        var stage = await session.Bridge!.ReachedAsync(token);
        Program.Require(!File.Exists(run.Marker) && run.EnginePins.Single().Alive, "count2_precondition_original_engine_suspended");
        run.Values["count2Stage"] = stage;
        run.Values["count2LeaseHeld"] = run.Bundle.MutableModels();
        await session.Bridge.ReleaseAsync(token);
        await run.FinishNaturalAsync(session, token);
        var active = Probe.JobAccounting(job).ActiveProcesses;
        var record = Program.Parse(Program.Utf8.GetString(File.ReadAllBytes(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId)))).GetProperty("record");
        Program.Require(Program.Text(record, "resumeState") == "uncertain" && Program.Text(record.GetProperty("completion"), "stage") == "resume" && active == 0 && !File.Exists(run.Marker), "actual_count2_must_not_be_resumed_twice");
        run.Values["firstActionAbsent"] = true; run.Values["originalEngineCount"] = Probe.JobAccounting(job).TotalProcesses;
        var successAuthorizeAck = await run.ObserveAuthorizeAckAsync(session, token);
        run.Values["successAuthorizeAck"] = successAuthorizeAck;
        Program.Require(!successAuthorizeAck, "count2_received_forbidden_success_authorize_ack");
        run.Values["realCount2Bridge"] = true; run.Values["treeObservedBeforeResourceRelease"] = true;
    }
    private static async Task Count2LegacyAsync(RunContext run, CancellationToken token)
    {
        using var installation = TrustedInstallation.Open(run.Bundle.Root, run.Bundle.ManifestSha256, run.Bundle.Selection);
        Program.Require(installation.CreateArguments(run.InputPath, run.OutputPath).SequenceEqual(run.Bundle.Arguments(run.InputPath, run.OutputPath)), "legacy_fixed_recipe");
        using var job = JobProcess.Prepare(installation.Launch.ExecutablePath, installation.CreateArguments(run.InputPath, run.OutputPath), run.Directory);
        var pin = ProcessPin.Open(checked((uint)job.EngineIdentity.Pid)); run.EnginePins.Add(pin);
        Program.Require(pin.Identity.CreationFileTime == job.EngineIdentity.CreationFileTime.ToString(CultureInfo.InvariantCulture) && pin.Alive, "legacy_original_engine_pin");
        await run.RegisterAsync(pin, token);
        var guard = run.OpenJob(job.JobName);
        // Own independent read handles before the legacy wrapper disposes its
        // streams. These drains prove EOF on duplicated original pipe objects,
        // not completion of the new session's original drain contract.
        var outputHandle = Probe.DuplicateLocal(((FileStream)job.StandardOutput).SafeFileHandle);
        var errorHandle = Probe.DuplicateLocal(((FileStream)job.StandardError).SafeFileHandle);
        var output = new Capture(new StreamReader(new FileStream(outputHandle, FileAccess.Read), Program.Utf8, false));
        var error = new Capture(new StreamReader(new FileStream(errorHandle, FileAccess.Read), Program.Utf8, false));
        var previous = Probe.AddOriginalPrimarySuspension(pin);
        Exception? failure = null;
        try { job.AuthorizeOnce(); } catch (Exception caught) { failure = caught; }
        await pin.WaitAsync(token); await Task.WhenAll(output.Completion, error.Completion).WaitAsync(token);
        var disposed = false; try { job.Inspect(); } catch (ObjectDisposedException) { disposed = true; }
        var active = Probe.JobAccounting(guard).ActiveProcesses;
        Program.Require(previous == 1 && failure is InvalidOperationException && disposed && active == 0 && !File.Exists(run.Marker) && output.Eof && error.Eof && output.Error is null && error.Error is null, "legacy_public_wrapper_count2_contract");
        run.Values["legacyCount2"] = new { previousSuspendCount = previous, actualOriginalThread = true, exceptionType = failure!.GetType().Name, exceptionMessage = failure.Message, firstActionAbsent = !File.Exists(run.Marker), originalEngineJoined = pin.Joined, activeProcesses = active, publicWrapperDisposed = disposed, independentStdoutEof = output.Eof, independentStderrEof = error.Eof, secondResumeAttempted = false };
    }
    private static bool AllDenied(object[] probes)
    {
        return probes.Select(Program.Element).All(probe => new[] { "write", "delete", "rename" }.All(key => !probe.GetProperty(key).GetProperty("success").GetBoolean() && probe.GetProperty(key).GetProperty("nativeError").GetInt32() is 5 or 32));
    }
    private static async Task UnknownRetentionAsync(RunContext run, CancellationToken token)
    {
        var noReceipt = run.Scenario.StartsWith("prepare-no-receipt", StringComparison.Ordinal);
        var slowDiagnostic = run.Scenario == "prepare-no-receipt-slow-diagnostic";
        var plan = noReceipt ? new BridgePlan("request", "RecordVerified", slowDiagnostic ? "PrepareNativeFailureSlowDiagnostic" : "PrepareNativeFailure") : new BridgePlan("terminal", "BeforeForce", run.Scenario == "force-denied" ? "ForceQueryOnly" : "CloseOriginalJob");
        var session = await run.SessionAsync(token, plan: plan);
        JsonElement descriptor = default;
        SafeFileHandle? exactGuard = null;
        JsonElement? prepareRequest = noReceipt ? run.PrepareRequest(session) : null;
        if (prepareRequest is { } request) await run.SendFrameAsync(session, request, token);
        else
        {
            descriptor = await run.PrepareAsync(session, token);
            var original = run.PinFact(descriptor.GetProperty("details").GetProperty("engine")); await run.RegisterAsync(original, token);
            exactGuard = run.OpenJob(Program.Text(descriptor.GetProperty("details"), "jobName"), terminate: true);
            Program.Require(Probe.InJob(original.Handle, exactGuard), "unknown_exact_original_job_guard");
            await run.SendFrameAsync(session, run.Request("stop", session.Subject.ExecutionId!), token);
        }
        var stage = await session.Bridge!.ReachedAsync(token);
        run.Values["unknownFaultStage"] = stage;
        Program.Require(!File.Exists(run.Marker), "unknown_fault_original_unresumed_tree");
        await session.Bridge.ReleaseAsync(token);
        var unknownEvent = await run.EventAsync(session, "evidenceOutcome", "unknown", token);
        if (prepareRequest is { } originalRequest)
        {
            run.Values["prepareFailureResponse"] = await run.ReplyAsync(session, originalRequest, token);
            run.Values["diagnosticPastDeadline"] = Program.Now > run.Spec.GetProperty("executionDeadlineAt").GetInt64();
        }
        var inspected = await run.ExchangeAsync(session, "inspect", token, observer: true);
        var state = inspected.GetProperty("state");
        if (noReceipt)
        {
            var path = Readback.RecordPath(run.RecordsRoot, run.Scope, "00000000000000000000000000000007");
            JsonElement? record = null;
            if (File.Exists(path))
            {
                var file = Program.Element(Probe.FileEvidence(path, includeBytes: true));
                var envelope = Program.Parse(Program.Utf8.GetString(Convert.FromBase64String(Program.Text(file, "bytesBase64"))));
                record = envelope.GetProperty("record").Clone();
            }
            run.Values["prepareDiagnostic"] = new { present = record is not null, record };
        }
        var held = run.Bundle.MutableModels();
        var helperLive = session.Subject.Pin.Alive;
        var terminalAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId));
        Program.Require(Program.Text(state, "phase") == "unknown" && Program.Text(state, "evidenceOutcome") == "unknown" && state.GetProperty("completion").ValueKind == JsonValueKind.Null && helperLive && terminalAbsent && AllDenied(held), "unknown_must_retain_pins_and_pending_original_helper");
        var originalEngineJoined = false; var guardActive0 = false;
        if (exactGuard is not null)
        {
            Probe.Check(Probe.TerminateJobObject(exactGuard, 1), "explicit_fault_guard_terminate_same_original_job");
            await run.JoinEnginesAsync(token);
            guardActive0 = Probe.JobAccounting(exactGuard).ActiveProcesses == 0;
            originalEngineJoined = run.EnginePins.All(pin => pin.Joined && !pin.Alive);
            Program.Require(guardActive0 && originalEngineJoined, "explicit_fault_guard_original_tree_join");
        }
        // The fixture now deliberately contains the exact still-pending helper.
        // This is neither a production recovery path nor a natural helper exit.
        session.Subject.Terminate(); await session.Subject.JoinAsync(token);
        run.Values["unknownRetention"] = new { unknownObserved = true, actualUnknownEvent = unknownEvent, actualInspect = inspected, helperStillLive = helperLive, terminalAbsent, completionPending = true, installationPinsHeld = AllDenied(held), installationAttempts = held, forcedFaultCleanup = true, exactOriginalHelperJoined = session.Subject.Pin.Joined, exactOriginalJobGuard = exactGuard is not null, guardObservedActive0 = guardActive0, originalEngineJoined, faultIsQueryOnlySameOriginalJob = run.Scenario == "force-denied", originalOwningJobRetained = run.Scenario == "force-denied", originalOwningJobDeliberatelyClosed = run.Scenario == "closed-original-job", engineSignalIsNotOriginalJobProof = run.Scenario == "closed-original-job", noPrepareReceipt = noReceipt };
        await run.ReadbackAsync(session, token);
    }
    private static async Task DrainFailureAsync(RunContext run, CancellationToken token)
    {
        var session = await run.SessionAsync(token, plan: new("prepared", "BeforeDrainRead", "DrainFailure"));
        await run.SendFrameAsync(session, run.PrepareRequest(session), token);
        var stage = await session.Bridge!.ReachedAsync(token);
        var pin = run.PinStage(stage) ?? throw new InvalidDataException("drain_fault_original_engine_missing");
        await run.RegisterAsync(pin, token);
        var job = run.OpenJob(Program.Text(stage.GetProperty("observation"), "jobName"));
        Program.Require(Probe.InJob(pin.Handle, job) && pin.Alive, "drain_fault_has_real_original_tree");
        await session.Bridge.ReleaseAsync(token);
        await session.Subject.JoinAsync(token); await run.JoinEnginesAsync(token);
        var active = Probe.JobAccounting(job).ActiveProcesses;
        var absent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId));
        var mutable = run.Bundle.MutableModels();
        var released = mutable.Select(Program.Element).All(value => new[] { "write", "delete", "rename" }.All(key => value.GetProperty(key).GetProperty("success").GetBoolean()));
        Program.Require(active == 0 && absent && released && !session.Subject.Forced, "drain_failure_must_not_invent_eof_or_early_resource_release");
        run.Values["drainFailure"] = new { explicitlyInjected = true, originalEngineJoined = pin.Joined, originalJobActive0 = active == 0, terminalAbsent = absent, unknownObserved = true, unknownBasis = "explicit-drain-failure-and-incomplete-terminal", helperResourcesSafelyReleased = released, heldOriginalTree = pin.Identity, actualFaultStage = stage, releaseProbes = mutable };
        await run.ReadbackAsync(session, token);
    }
    private static async Task CrashAsync(RunContext run, CancellationToken token)
    {
        var resumed = run.Scenario == "crash-resume-before-ack";
        var session = await run.SessionAsync(token, plan: new("auth", resumed ? "AfterResumeBeforeAck" : "AuthVerifiedBeforeResumeGate", "None"));
        var descriptor = await run.PrepareAsync(session, token);
        var pin = run.PinFact(descriptor.GetProperty("details").GetProperty("engine")); await run.RegisterAsync(pin, token);
        await run.SendFrameAsync(session, run.BindOriginalAuthorize(session, descriptor), token);
        var stage = await session.Bridge!.ReachedAsync(token);
        if (resumed) await run.PeerAsync("engine", descriptor, token);
        Program.Require(File.Exists(run.Marker) == resumed, "crash_real_resume_stage_binding");
        var before = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
        run.CloseJobHandles();
        session.Subject.Terminate(); await session.Subject.JoinAsync(token); await run.JoinEnginesAsync(token);
        var successAuthorizeAck = await run.ObserveAuthorizeAckAsync(session, token);
        Program.Require(!successAuthorizeAck, "crash_received_forbidden_success_authorize_ack");
        var terminalAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId));
        Program.Require(terminalAbsent, "crash_cannot_publish_a_terminal");
        var second = await run.SessionAsync(token);
        await run.SendFrameAsync(second, run.PrepareRequest(second), token);
        await second.Subject.JoinAsync(token);
        var after = Readback.RawSnapshot(run.RecordsRoot, run.Scope);
        var unchanged = Program.Equal(before, after);
        Program.Require(unchanged && run.EnginePins.Count == 1, "existing_must_not_repair_or_create_another_original_tree");
        run.Values["crash"] = new { intentionallyTerminatedOriginalHelper = session.Subject.Forced, allExtraJobHandlesClosedBeforeCrash = true, originalEngineJoined = pin.Joined, terminalAbsent, existingRefused = true, secondTreeAbsent = true, originalRecordsUnchanged = unchanged, firstActionCreated = File.Exists(run.Marker), successAuthorizeAck, originalStage = stage, originalRecords = before, afterExisting = after, originalExecutionId = session.Subject.ExecutionId, refusingExecutionId = second.Subject.ExecutionId };
        await run.ReadbackAsync(session, token);
    }
}

// These probes deliberately do not call production validators. All process,
// Job, pipe, file identity, ACL and read-only fault facts come from Win32.
internal static class Probe
{
    internal static string CurrentSid { get; } = CurrentUser();
    private static string CurrentUser() { using var current = WindowsIdentity.GetCurrent(); return current.User?.Value ?? throw new InvalidDataException("fixture_current_sid"); }
    internal sealed record FileIdentityValue(string VolumeSerial, string FileId);
    internal sealed record Attempt(bool Success, int NativeError);
    [StructLayout(LayoutKind.Sequential)]
    internal struct Accounting
    {
        internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileStandard
    {
        internal long AllocationSize, EndOfFile;
        internal uint Links;
        [MarshalAs(UnmanagedType.U1)] internal bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] internal bool Directory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileBasic { internal long Creation, LastAccess, LastWrite, Change; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        internal long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        internal BasicLimits Basic;
        internal IoCounters Io;
        internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ThreadEntry
    {
        internal uint Size, Usage, ThreadId, OwnerPid;
        internal int BasePriority, DeltaPriority;
        internal uint Flags;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup
    {
        internal uint Cb;
        internal string? Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        internal ushort ShowWindow, Reserved2Bytes;
        internal IntPtr Reserved2, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupEx { internal Startup Startup; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CreatedProcess { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeUnicodeString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }

    internal static void Check(bool success, string stage) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), stage); }
    internal static IntPtr Pointer(string value)
    {
        Program.Require(ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed.ToString(CultureInfo.InvariantCulture) == value && parsed != 0 && parsed <= long.MaxValue, "fixture_handle_decimal");
        return new IntPtr(unchecked((long)parsed));
    }
    internal static bool NonInherited(SafeHandle handle) { Check(GetHandleInformation(handle, out var flags), "independent_handle_flags"); return (flags & 1) == 0; }
    internal static bool Signaled(SafeHandle handle)
    {
        var result = WaitForSingleObject(handle, 0);
        if (result == 0) return true;
        if (result == 258) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error(), "independent_process_signal");
    }
    internal static ulong CreationTime(SafeHandle process) { Check(GetProcessTimes(process, out var creation, out _, out _, out _), "independent_process_creation"); return unchecked((ulong)creation); }
    internal static string ProcessSid(SafeHandle process)
    {
        Check(OpenProcessToken(process, 8, out var token), "independent_process_token");
        using (token)
        {
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out var size);
            Program.Require(size > 0, "independent_token_buffer_size");
            var memory = Marshal.AllocHGlobal(checked((int)size));
            try { Check(GetTokenInformation(token, 1, memory, size, out _), "independent_token_user"); return new SecurityIdentifier(Marshal.ReadIntPtr(memory)).Value; }
            finally { Marshal.FreeHGlobal(memory); }
        }
    }
    internal static string ProcessImagePath(SafeHandle process, List<object> attempts, CancellationToken token)
    {
        var headerBytes = checked((uint)Marshal.SizeOf<NativeUnicodeString>());
        uint capacity = 0;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var memory = capacity == 0 ? IntPtr.Zero : Marshal.AllocHGlobal(checked((nint)capacity));
            try
            {
                var startedTick = Environment.TickCount64;
                var status = NtQueryInformationProcess(process, 27, memory, capacity, out var returned);
                attempts.Add(new { kind = "native-query", startedTick, endedTick = Environment.TickCount64, bufferBytes = capacity, returnedBytes = returned, ntStatus = status, ntStatusHex = unchecked((uint)status).ToString("x8", CultureInfo.InvariantCulture) });
                if (status == unchecked((int)0xc0000004))
                {
                    Program.Require(returned >= headerBytes && returned > capacity, "diagnostic_image_required_length_did_not_grow");
                    capacity = returned; continue;
                }
                Program.Require(status == 0, "diagnostic_image_native_query_failed");
                Program.Require(capacity >= headerBytes && returned >= headerBytes && returned <= capacity, "diagnostic_image_returned_length_invalid");
                var text = Marshal.PtrToStructure<NativeUnicodeString>(memory);
                attempts.Add(new { kind = "unicode-string-layout", headerBytes, lengthBytes = text.Length, maximumLengthBytes = text.MaximumLength, allocationAddress = unchecked((ulong)memory.ToInt64()).ToString(CultureInfo.InvariantCulture), bufferAddress = unchecked((ulong)text.Buffer.ToInt64()).ToString(CultureInfo.InvariantCulture) });
                Program.Require(text.Length <= text.MaximumLength && (text.Length & 1) == 0 && (text.MaximumLength & 1) == 0, "diagnostic_image_unicode_lengths_invalid");
                if (text.Buffer == IntPtr.Zero)
                {
                    Program.Require(text.Length == 0 && text.MaximumLength == 0, "diagnostic_image_null_string_buffer");
                    return string.Empty;
                }
                var start = unchecked((ulong)memory.ToInt64());
                var end = checked(start + returned);
                var buffer = unchecked((ulong)text.Buffer.ToInt64());
                Program.Require(buffer >= checked(start + headerBytes) && buffer <= end && text.MaximumLength <= end - buffer, "diagnostic_image_string_outside_returned_buffer");
                var bytes = new byte[text.Length]; Marshal.Copy(text.Buffer, bytes, 0, bytes.Length);
                return new UnicodeEncoding(false, false, true).GetString(bytes);
            }
            finally { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
        }
    }
    internal static uint GrantedAccess(SafeHandle handle)
    {
        var memory = Marshal.AllocHGlobal(56);
        try { var status = NtQueryObject(handle, 0, memory, 56, out _); Program.Require(status == 0, "independent_granted_access_query"); return unchecked((uint)Marshal.ReadInt32(memory, 4)); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    internal static async Task WaitProcessAsync(SafeHandle process, CancellationToken token)
    {
        var retained = false;
        try
        {
            process.DangerousAddRef(ref retained);
            using var wait = new NativeWait(process);
            var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var registration = ThreadPool.RegisterWaitForSingleObject(wait, (_, timedOut) => { if (!timedOut) done.TrySetResult(); }, null, Timeout.Infinite, true);
            using var cancellation = token.Register(() => done.TrySetCanceled(token));
            try { await done.Task; Program.Require(Signaled(process), "independent_original_wait_not_signaled"); }
            finally { registration.Unregister(null); }
        }
        finally { if (retained) process.DangerousRelease(); }
    }
    private sealed class NativeWait : WaitHandle { internal NativeWait(SafeHandle handle) => SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), false); }
    internal static SafeFileHandle DuplicateLocal(SafeHandle source)
    {
        Check(DuplicateHandle(GetCurrentProcess(), source.DangerousGetHandle(), GetCurrentProcess(), out var copy, 0, false, 2), "independent_duplicate_original_handle");
        return new SafeFileHandle(copy, true);
    }
    internal static string DuplicateTo(IntPtr source, SafeFileHandle target)
    {
        Check(DuplicateHandleTo(GetCurrentProcess(), source, target, out var copy, 0, false, 2), "independent_duplicate_exact_target");
        return unchecked((ulong)copy.ToInt64()).ToString(CultureInfo.InvariantCulture);
    }
    internal static IntPtr StreamHandle(Stream stream) => stream switch { FileStream file => file.SafeFileHandle.DangerousGetHandle(), PipeStream pipe => pipe.SafePipeHandle.DangerousGetHandle(), _ => throw new InvalidDataException("redirected_original_stream_handle_type") };
    internal static bool InJob(SafeHandle process, SafeFileHandle job) { Check(IsProcessInJob(process, job, out var member), "independent_job_membership"); return member; }
    internal static Accounting JobAccounting(SafeFileHandle job) { Check(QueryInformationJobObject(job, 1, out Accounting accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero), "independent_job_accounting"); return accounting; }
    internal static uint[] JobMembers(SafeFileHandle job, CancellationToken token)
    {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST declares ProcessIdList[1], even for active0.
        var capacity = Math.Max(1u, JobAccounting(job).ActiveProcesses);
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var bytes = checked(8 + (int)capacity * IntPtr.Size);
            var memory = Marshal.AllocHGlobal(bytes);
            try
            {
                Marshal.WriteInt32(memory, 0, 0); Marshal.WriteInt32(memory, 4, 0);
                if (!QueryJobMembers(job, 3, memory, (uint)bytes, out var returned))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 234) throw new Win32Exception(error, "independent_job_member_query");
                    var assigned = checked((uint)Marshal.ReadInt32(memory));
                    var required = returned > 8 ? (returned - 8) / (uint)IntPtr.Size : 0;
                    var larger = Math.Max(assigned, required);
                    Program.Require(larger > capacity, "independent_job_required_size_did_not_grow"); capacity = larger; continue;
                }
                var count = checked((uint)Marshal.ReadInt32(memory, 4));
                Program.Require(count <= capacity, "independent_job_returned_count_exceeds_buffer");
                return Enumerable.Range(0, checked((int)count)).Select(index => checked((uint)Marshal.ReadIntPtr(memory, 8 + index * IntPtr.Size).ToInt64())).ToArray();
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
    }
    internal static void KillOnClose(SafeFileHandle job)
    {
        var limits = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = 0x00002000 } };
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()), "independent_guard_kill_on_close");
    }
    internal static NamedPipeServerStream LocalServer(string leaf, bool first)
    {
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + CurrentSid + "D:P(A;;0x001f019f;;;" + CurrentSid + ")", 1, out var descriptor, out _), "independent_pipe_descriptor");
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false };
            var handle = CreateNamedPipeW(@"\\.\pipe\" + leaf, 3u | 0x40000000u | (first ? 0x00080000u : 0u), 8, 255, 0, 0, 0, ref security);
            Check(!handle.IsInvalid, "independent_local_pipe_create");
            try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); } catch { handle.Dispose(); throw; }
        }
        finally { LocalFree(descriptor); }
    }
    internal static uint PipeCapacity(IntPtr handle)
    {
        using var original = new SafeFileHandle(handle, false);
        Check(GetNamedPipeInfo(original, out _, out var output, out var input, out _), "independent_actual_pipe_capacity");
        var capacity = Math.Max(output, input); Program.Require(capacity > 0, "independent_pipe_capacity_not_positive"); return capacity;
    }
    internal static SafeFileHandle OpenFile(string path)
    {
        if (!path.StartsWith(@"\\?\", StringComparison.Ordinal) && !path.StartsWith(@"\\.\", StringComparison.Ordinal))
        {
            path = Path.GetFullPath(path);
            path = path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path[2..] : @"\\?\" + path;
        }
        var handle = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error, "independent_file_open"); }
        return handle;
    }
    internal static FileIdentityValue NativeImageFileIdentity(string nativePath)
    {
        Program.Require(nativePath.StartsWith(@"\Device\", StringComparison.Ordinal) && !nativePath.Contains('\0'), "native_device_image_path_required");
        using var image = OpenFile(@"\\?\GLOBALROOT" + nativePath);
        return FileIdentity(image);
    }
    internal static void CreateDirectory(string path)
    {
        var sid = new SecurityIdentifier(CurrentSid); var security = new DirectorySecurity();
        security.SetOwner(sid); security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(sid, (FileSystemRights)0x001f01ff, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).Create(security);
    }
    internal static void CreateFile(string path, byte[] bytes)
    {
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + CurrentSid + "D:P(A;;0x001f01ff;;;" + CurrentSid + ")", 1, out var descriptor, out _), "independent_file_descriptor");
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false };
            using var handle = CreateProtectedFileW(path, 0xc0010000, 7, ref security, 1, 0x00200080, IntPtr.Zero);
            Check(!handle.IsInvalid, "independent_protected_create_new");
            if (bytes.Length != 0) { Check(WriteFile(handle, bytes, checked((uint)bytes.Length), out var written, IntPtr.Zero), "independent_original_file_write"); Program.Require(written == bytes.Length, "independent_partial_original_write"); }
            Check(FlushFileBuffers(handle), "independent_original_file_flush");
        }
        finally { LocalFree(descriptor); }
    }
    internal static void ReplaceOwnBytes(string path, byte[] bytes)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        stream.Write(bytes); stream.SetLength(bytes.Length); stream.Flush(true);
    }
    internal static FileIdentityValue FileIdentity(SafeFileHandle handle)
    {
        var memory = Marshal.AllocHGlobal(24);
        try
        {
            Check(GetFileIdentityInformation(handle, 18, memory, 24), "independent_original_file_id");
            var bytes = new byte[16]; Marshal.Copy(IntPtr.Add(memory, 8), bytes, 0, bytes.Length);
            return new(unchecked((ulong)Marshal.ReadInt64(memory)).ToString(CultureInfo.InvariantCulture), Convert.ToHexStringLower(bytes));
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    internal static byte[] Bytes(SafeFileHandle handle)
    {
        using var output = new MemoryStream(); var buffer = new byte[64 * 1024];
        long offset = 0; int read;
        while ((read = RandomAccess.Read(handle, buffer, offset)) != 0) { output.Write(buffer, 0, read); offset = checked(offset + read); }
        return output.ToArray();
    }
    internal static string FileHash(SafeFileHandle handle) => Program.Hash(Bytes(handle));
    private static JsonElement Security(SafeHandle handle)
    {
        var error = GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out var descriptor);
        if (error != 0) throw new Win32Exception(unchecked((int)error), "independent_original_file_security");
        try
        {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0); var acl = security.DiscretionaryAcl;
            return Program.Element(new { ownerMatchesCurrentSid = security.Owner?.Value == CurrentSid, daclPresent = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent), protectedDacl = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected), aceCount = acl?.Count ?? 0, aces = acl?.Cast<GenericAce>().Select(ace => new { type = ace.AceType.ToString(), flags = (int)ace.AceFlags, accessMask = ace is KnownAce known ? known.AccessMask : 0, sidMatchesCurrent = ace is KnownAce named && named.SecurityIdentifier.Value == CurrentSid }).ToArray() });
        }
        finally { LocalFree(descriptor); }
    }
    internal static void RequireProtected(SafeFileHandle handle)
    {
        Check(GetFileStandardInformation(handle, 1, out var standard, (uint)Marshal.SizeOf<FileStandard>()), "independent_file_standard");
        Check(GetFileBasicInformation(handle, 0, out var basic, (uint)Marshal.SizeOf<FileBasic>()), "independent_file_basic");
        var security = Security(handle); var aces = security.GetProperty("aces");
        Program.Require(NonInherited(handle) && !standard.DeletePending && (basic.Attributes & 0x400) == 0 && (standard.Directory || standard.Links == 1) && security.GetProperty("ownerMatchesCurrentSid").GetBoolean() && security.GetProperty("daclPresent").GetBoolean() && security.GetProperty("protectedDacl").GetBoolean() && security.GetProperty("aceCount").GetInt32() == 1 && aces[0].GetProperty("type").GetString() == "AccessAllowed" && aces[0].GetProperty("flags").GetInt32() == 0 && aces[0].GetProperty("accessMask").GetInt32() == 0x001f01ff && aces[0].GetProperty("sidMatchesCurrent").GetBoolean(), "independent_exact_protected_file");
    }
    internal static object FileEvidence(string path, bool includeBytes = false)
    {
        using var handle = OpenFile(path); RequireProtected(handle);
        Check(GetFileStandardInformation(handle, 1, out var standard, (uint)Marshal.SizeOf<FileStandard>()), "independent_file_evidence_standard");
        var bytes = standard.Directory ? [] : Bytes(handle);
        return new { identity = FileIdentity(handle), security = Security(handle), nonInherited = NonInherited(handle), links = standard.Links, directory = standard.Directory, deletePending = standard.DeletePending, length = standard.EndOfFile.ToString(CultureInfo.InvariantCulture), sha256 = standard.Directory ? null : Program.Hash(bytes), bytesBase64 = includeBytes && !standard.Directory ? Convert.ToBase64String(bytes) : null };
    }
    internal static Attempt OpenAttempt(string path, uint access)
    {
        using var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        return new(!handle.IsInvalid, handle.IsInvalid ? Marshal.GetLastWin32Error() : 0);
    }
    internal static Attempt RenameAttempt(string path)
    {
        var target = path + ".fixture-rename";
        Program.Require(!File.Exists(target) && !Directory.Exists(target), "lease_probe_rename_collision");
        var success = MoveFileExW(path, target, 0); var error = success ? 0 : Marshal.GetLastWin32Error();
        if (success) Check(MoveFileExW(target, path, 0), "lease_probe_restore_same_original_file");
        return new(success, error);
    }
    internal static void RequireFixedNtfs(string path, SafeFileHandle handle)
    {
        var mount = new StringBuilder(32768); Check(GetVolumePathNameW(path, mount, (uint)mount.Capacity), "independent_volume_mount");
        var name = new StringBuilder(32768); var filesystem = new StringBuilder(32768);
        Check(GetVolumeInformationByHandleW(handle, name, (uint)name.Capacity, out _, out _, out var flags, filesystem, (uint)filesystem.Capacity), "independent_volume_information");
        Program.Require(GetDriveTypeW(mount.ToString()) == 3 && filesystem.ToString() == "NTFS" && (flags & 8) != 0, "independent_local_fixed_ntfs_required");
        Program.Require(FinalGuidPath(handle).StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase), "independent_ntfs_guid_path_binding");
    }
    internal static string FinalGuidPath(SafeFileHandle handle)
    {
        var required = GetFinalPathNameByHandleW(handle, null, 0, 1); Check(required > 0, "independent_final_guid_path_size");
        var buffer = new StringBuilder(checked((int)required));
        var written = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 1); Check(written > 0 && written < buffer.Capacity, "independent_final_guid_path");
        return buffer.ToString();
    }
    internal static uint AddOriginalPrimarySuspension(ProcessPin engine)
    {
        Program.Require(engine.Alive, "count2_original_engine_not_live");
        using var snapshot = CreateToolhelp32Snapshot(4, 0); Check(!snapshot.IsInvalid, "count2_one_actual_thread_snapshot");
        var entry = new ThreadEntry { Size = (uint)Marshal.SizeOf<ThreadEntry>() }; var ids = new List<uint>();
        var more = Thread32First(snapshot, ref entry);
        while (more) { if (entry.OwnerPid == engine.Identity.Pid) ids.Add(entry.ThreadId); entry.Size = (uint)Marshal.SizeOf<ThreadEntry>(); more = Thread32Next(snapshot, ref entry); }
        var finalError = Marshal.GetLastWin32Error(); Program.Require(finalError == 18 && ids.Count == 1 && engine.Alive, "count2_single_original_suspended_primary_thread");
        using var thread = OpenThread(0x0042, false, ids[0]); Check(!thread.IsInvalid, "count2_open_exact_original_thread");
        Program.Require(GetProcessIdOfThread(thread) == engine.Identity.Pid && engine.Alive, "count2_thread_original_process_binding");
        var count = SuspendThread(thread); var error = Marshal.GetLastWin32Error();
        if (count == uint.MaxValue) throw new Win32Exception(error, "count2_actual_suspend_thread");
        Program.Require(count == 1 && engine.Alive, "count2_actual_previous_suspension_must_be_one");
        return count;
    }
    private static string Quote(string argument)
    {
        var result = new StringBuilder("\""); var slashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append(character); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(character);
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    internal static ProcessPin SpawnInherited(string executable, IReadOnlyList<string> args, string directory)
    {
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero; UIntPtr bytes = UIntPtr.Zero;
        CreatedProcess created = default;
        try
        {
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            Program.Require(bytes != UIntPtr.Zero, "descendant_attribute_real_size");
            attributes = Marshal.AllocHGlobal(checked((int)bytes)); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes), "descendant_attribute_list");
            var standard = new[] { GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12) };
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            for (var index = 0; index < standard.Length; index++) { Check(SetHandleInformation(standard[index], 1, 1), "descendant_explicit_std_inherit"); Marshal.WriteIntPtr(handles, index * IntPtr.Size, standard[index]); }
            Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020002), handles, new UIntPtr((uint)(3 * IntPtr.Size)), IntPtr.Zero, IntPtr.Zero), "descendant_exact_std_handle_list");
            var startup = new StartupEx { Startup = new Startup { Cb = (uint)Marshal.SizeOf<StartupEx>(), Flags = 0x100, Input = standard[0], Output = standard[1], Error = standard[2] }, Attributes = attributes };
            var command = new StringBuilder(string.Join(' ', new[] { executable }.Concat(args).Select(Quote)));
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, directory, ref startup, out created), "descendant_real_inherited_process_create");
            using var thread = new SafeFileHandle(created.Thread, true);
            var pin = ProcessPin.Adopt(new SafeFileHandle(created.Process, true));
            Program.Require(pin.Identity.Pid == created.ProcessId, "descendant_original_process_identity");
            return pin;
        }
        finally
        {
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeFileHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetProcessId(SafeHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(SafeHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(SafeHandle process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(SafeHandle process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr copy, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", EntryPoint = "DuplicateHandle", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandleTo(IntPtr sourceProcess, IntPtr source, SafeFileHandle targetProcess, out IntPtr copy, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenProcessToken(SafeHandle process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetTokenInformation(SafeFileHandle token, int informationClass, IntPtr information, uint bytes, out uint returned);
    [DllImport("ntdll.dll")] private static extern int NtQueryObject(SafeHandle handle, int informationClass, IntPtr information, uint bytes, out uint returned);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(SafeHandle process, int informationClass, IntPtr information, uint bytes, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeFileHandle CreateJobObjectW(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(SafeHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool member);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle OpenJobObjectW(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass, out Accounting accounting, uint bytes, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryJobMembers(SafeFileHandle job, int informationClass, IntPtr information, uint bytes, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref ExtendedLimits information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeInfo(SafeHandle pipe, out uint flags, out uint outputSize, out uint inputSize, out uint maximumInstances);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maximumInstances, uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes security);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateProtectedFileW(string path, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WriteFile(SafeFileHandle handle, byte[] bytes, uint bytesToWrite, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileIdentityInformation(SafeFileHandle handle, int informationClass, IntPtr information, uint bytes);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileStandardInformation(SafeFileHandle handle, int informationClass, out FileStandard information, uint bytes);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileBasicInformation(SafeFileHandle handle, int informationClass, out FileBasic information, uint bytes);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeHandle handle, uint kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool MoveFileExW(string oldPath, string newPath, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumePathNameW(string path, StringBuilder mount, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveTypeW(string mount);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder name, uint nameLength, out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder filesystem, uint filesystemLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder? name, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Thread32First(SafeFileHandle snapshot, ref ThreadEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Thread32Next(SafeFileHandle snapshot, ref ThreadEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenThread(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessIdOfThread(SafeFileHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint SuspendThread(SafeFileHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, UIntPtr bytes, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcessW(string executable, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out CreatedProcess created);
}
