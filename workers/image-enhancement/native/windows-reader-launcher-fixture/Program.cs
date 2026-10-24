using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsReaderLauncherFixture;

// Test-only ordinary apphost. It never starts an engine, controller or descendant.
// Every resource budget is supplied by the test directory's control document.
internal static class Program
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    private sealed class Control
    {
        public int V { get; init; }
        public string Mode { get; init; } = "";
        public int LifetimeMs { get; init; }
        public int MaxRequestBytes { get; init; }
        public int MaxResponseBytes { get; init; }
        public int MaxStderrBytes { get; init; }
        public int FloodBytes { get; init; }
        public int ExitCode { get; init; }
    }

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows() || args.Length != 2 || args[0] != "--read-records")
                return 90;
            string root = args[1];
            Control control = JsonSerializer.Deserialize<Control>(
                await File.ReadAllBytesAsync(Path.Combine(root, "control.json")), Json)
                ?? throw new InvalidDataException();
            if (control.V != 1 || control.LifetimeMs <= 0 || control.MaxRequestBytes <= 0 ||
                control.MaxResponseBytes <= 0 || control.MaxStderrBytes <= 0 ||
                control.FloodBytes < 0 || control.ExitCode is < 0 or > 255 ||
                control.Mode is not ("respond" or "respond-live" or "eof-live" or "hold" or
                    "flood" or "stdout-flood" or "stderr-flood" or "stdin-close" or "sentinel"))
                return 91;

            if (control.Mode == "stdin-close")
            {
                CloseOwnStandardHandle(-10);
                await ReadyAsync(root, control.Mode, args);
                return await AwaitReleaseAsync(root, control.LifetimeMs) ? control.ExitCode : 92;
            }
            if (control.Mode == "sentinel")
            {
                await ReadyAsync(root, control.Mode, args);
                return await AwaitReleaseAsync(root, control.LifetimeMs, answerProbe: true)
                    ? control.ExitCode : 92;
            }

            byte[] request = await ReadRequestAsync(control.MaxRequestBytes);
            await PublishAsync(root, "request.bin", request);
            await PublishJsonAsync(root, "input-eof", new
            {
                bytes = request.Length,
                sha256 = Convert.ToHexString(SHA256.HashData(request)).ToLowerInvariant(),
            });
            await ReadyAsync(root, control.Mode, args);

            if (control.Mode == "hold")
                return await AwaitReleaseAsync(root, control.LifetimeMs) ? control.ExitCode : 92;
            if (control.Mode is "flood" or "stdout-flood" or "stderr-flood")
            {
                using Stream output = Console.OpenStandardOutput();
                using Stream error = Console.OpenStandardError();
                await PublishAsync(root, "flood-started", Array.Empty<byte>());
                if (control.Mode == "stdout-flood")
                {
                    await FloodAsync(output, control.FloodBytes, 0x6f);
                    return control.ExitCode;
                }
                if (control.Mode == "stderr-flood")
                {
                    await FloodAsync(error, control.FloodBytes, 0x65);
                    return control.ExitCode;
                }
                // Issue both first chunks before the first output await. A one-byte
                // prefix could let stderr rejection kill us before any flood began.
                // These bytes are included in the caller's explicit flood budget.
                int prefixLength = Math.Min(control.FloodBytes, 16_384);
                byte[] outputPrefix = new byte[prefixLength];
                byte[] errorPrefix = new byte[prefixLength];
                Array.Fill(outputPrefix, (byte)0x6f);
                Array.Fill(errorPrefix, (byte)0x65);
                await Task.WhenAll(output.WriteAsync(outputPrefix).AsTask(),
                    error.WriteAsync(errorPrefix).AsTask());
                await Task.WhenAll(output.FlushAsync(), error.FlushAsync());
                await Task.WhenAll(FloodAsync(output, control.FloodBytes - prefixLength, 0x6f),
                    FloodAsync(error, control.FloodBytes - prefixLength, 0x65));
                return control.ExitCode;
            }

            byte[] response = await ReadPayloadAsync(root, "response.bin", control.MaxResponseBytes);
            using (Stream output = Console.OpenStandardOutput())
            {
                await output.WriteAsync(response);
                await output.FlushAsync();
            }
            string stderrPath = Path.Combine(root, "stderr.bin");
            if (File.Exists(stderrPath))
            {
                byte[] stderr = await ReadPayloadAsync(root, "stderr.bin", control.MaxStderrBytes);
                using Stream error = Console.OpenStandardError();
                await error.WriteAsync(stderr);
                await error.FlushAsync();
            }
            await PublishAsync(root, "response-written", Array.Empty<byte>());
            if (control.Mode == "respond") return control.ExitCode;
            if (control.Mode == "eof-live")
            {
                // Dispose Console stream wrappers is not a pipe-EOF receipt on Windows.
                // Close only this fixture's inherited standard handles. Node must separately
                // observe each original output stream's real end before the test accepts EOF.
                CloseOwnStandardHandle(-11);
                CloseOwnStandardHandle(-12);
                await PublishAsync(root, "outputs-closed", Array.Empty<byte>());
            }
            return await AwaitReleaseAsync(root, control.LifetimeMs) ? control.ExitCode : 92;
        }
        catch
        {
            // Do not turn fixture diagnostics into protocol output or public exception text.
            return 93;
        }
    }

    private static Task ReadyAsync(string root, string mode, string[] args) =>
        PublishJsonAsync(root, "ready", new { mode, cwd = Environment.CurrentDirectory, args });

    private static async Task<byte[]> ReadRequestAsync(int maximum)
    {
        using Stream input = Console.OpenStandardInput();
        using var request = new MemoryStream();
        byte[] chunk = new byte[Math.Min(maximum, 16_384)];
        while (true)
        {
            int length = await input.ReadAsync(chunk);
            if (length == 0) return request.ToArray();
            if (length > maximum - request.Length) throw new InvalidDataException();
            await request.WriteAsync(chunk.AsMemory(0, length));
        }
    }

    private static async Task<byte[]> ReadPayloadAsync(string root, string name, int maximum)
    {
        string path = Path.Combine(root, name);
        if (new FileInfo(path).Length > maximum) throw new InvalidDataException();
        byte[] payload = await File.ReadAllBytesAsync(path);
        if (payload.Length > maximum) throw new InvalidDataException();
        return payload;
    }

    private static async Task FloodAsync(Stream stream, int bytes, byte value)
    {
        byte[] chunk = new byte[Math.Min(Math.Max(bytes, 1), 16_384)];
        Array.Fill(chunk, value);
        for (int written = 0; written < bytes;)
        {
            int length = Math.Min(chunk.Length, bytes - written);
            await stream.WriteAsync(chunk.AsMemory(0, length));
            written += length;
        }
        await stream.FlushAsync();
    }

    private static async Task<bool> AwaitReleaseAsync(string root, int lifetimeMs, bool answerProbe = false)
    {
        var released = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        object observationGate = new();
        using var watcher = new FileSystemWatcher(root)
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite,
        };
        void Observe(string? name)
        {
            lock (observationGate)
            {
                try
                {
                    if (name == "release" && File.Exists(Path.Combine(root, "release")))
                        released.TrySetResult(true);
                    if (answerProbe && name == "probe" && File.Exists(Path.Combine(root, "probe")))
                    {
                        byte[] probe = File.ReadAllBytes(Path.Combine(root, "probe"));
                        string temporary = Path.Combine(root, "alive.tmp");
                        File.WriteAllBytes(temporary, probe);
                        File.Move(temporary, Path.Combine(root, "alive"), overwrite: true);
                    }
                }
                catch { released.TrySetException(new InvalidDataException()); }
            }
        }
        watcher.Created += (_, item) => Observe(item.Name);
        watcher.Changed += (_, item) => Observe(item.Name);
        watcher.Renamed += (_, item) => Observe(item.Name);
        watcher.Error += (_, _) => released.TrySetException(new InvalidDataException());
        watcher.EnableRaisingEvents = true;
        Observe("release");
        if (answerProbe) Observe("probe");
        try { return await released.Task.WaitAsync(TimeSpan.FromMilliseconds(lifetimeMs)); }
        catch (TimeoutException) { return false; }
    }

    private static Task PublishJsonAsync(string root, string name, object value) =>
        PublishAsync(root, name, JsonSerializer.SerializeToUtf8Bytes(value, Json));

    private static async Task PublishAsync(string root, string name, byte[] bytes)
    {
        string temporary = Path.Combine(root, name + ".tmp");
        await File.WriteAllBytesAsync(temporary, bytes);
        File.Move(temporary, Path.Combine(root, name), overwrite: true);
    }

    private static void CloseOwnStandardHandle(int standard)
    {
        using var owned = new SafeFileHandle(GetStdHandle(standard), ownsHandle: true);
        if (owned.IsInvalid) throw new InvalidDataException();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetStdHandle(int standard);
}
