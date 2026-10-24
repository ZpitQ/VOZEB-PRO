using System.Runtime.Versioning;
using System.ServiceProcess;
using System.Text.Json;
using Zeb.WindowsSupervisor;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsServiceHost;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return Fail("worker_platform_unsupported", 1);
        if (args.Length != 0 && !(args.Length == 1 && args[0] == "--console"))
            return Fail("worker_mode_invalid", 64);

        var baseDirectory = AppContext.BaseDirectory;
        var node = Path.Combine(baseDirectory, "runtime", "node.exe");
        var app = Path.Combine(baseDirectory, "app");
        var main = Path.Combine(app, "main.mjs");
        if (!File.Exists(node) || !File.Exists(main)) return Fail("worker_payload_unavailable", 2);

        try
        {
            using var output = Console.OpenStandardOutput();
            using var error = Console.OpenStandardError();
            using var session = new ContainedWorkerSession(node, [main], app,
                bytes => output.Write(bytes.Span), bytes => error.Write(bytes.Span));
            if (args.Length == 1)
            {
                ConsoleCancelEventHandler cancel = (sender, request) =>
                {
                    request.Cancel = true;
                    _ = session.GracefulStopAsync();
                };
                Console.CancelKeyPress += cancel;
                try { StartWorker(baseDirectory, session); await session.Completion; }
                finally { Console.CancelKeyPress -= cancel; }
            }
            else
            {
                using var service = new WindowsWorkerService(session);
                ServiceBase.Run(service);
                await service.StopObservation;
                await session.StopAsync();
            }
            return 0;
        }
        catch (Exception error) { return Fail("worker_host_failed:" + error.GetType().Name, 1); }
    }

    private static int Fail(string code, int exitCode) { Console.Error.WriteLine(code); return exitCode; }

    internal static void StartWorker(string baseDirectory, ContainedWorkerSession session, StartupObservation? observation = null)
    {
        try
        {
            string version = Path.TrimEndingDirectorySeparator(Path.GetFullPath(baseDirectory));
            string programRoot = Path.GetDirectoryName(version) ?? throw new InvalidDataException("worker_layout_invalid");
            using var config = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(version, "app", "worker.config.json")));
            if (config.RootElement.ValueKind != JsonValueKind.Object ||
                !config.RootElement.TryGetProperty("storeDirectory", out var property) || property.ValueKind != JsonValueKind.String ||
                property.GetString() is not { } store || !Path.IsPathFullyQualified(store) ||
                !string.Equals(Path.GetFileName(store), "store", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("worker_layout_invalid");
            string dataRoot = Path.GetDirectoryName(store) ?? throw new InvalidDataException("worker_layout_invalid");
            // Check the original token and layout before Prepare can create even a suspended Node.
            InstallationAncestorAccess.Validate(programRoot, dataRoot);
        }
        catch
        {
            // An unstarted session cannot finish by itself; its lifetime still joins this cleanup.
            if (observation is not null) _ = session.StopAsync();
            throw;
        }
        session.Start(observation);
    }
}

internal sealed class WindowsWorkerService : ServiceBase
{
    private readonly ContainedWorkerSession session;
    private readonly object startupSync = new();
    private bool startupSelected, stopRequested;
    private Task stopObservation = Task.CompletedTask;

    internal Task StopObservation { get { lock (startupSync) return stopObservation; } }

    internal WindowsWorkerService(ContainedWorkerSession session)
    {
        this.session = session;
        ServiceName = "ZebImageEnhancement";
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }

    protected override void OnStart(string[] args)
    {
        if (args.Length != 0)
        {
            if (args.Length != 2 || args[0] != "zeb-startup-observe-v1")
                throw new InvalidDataException("worker_startup_context_invalid");
            var observation = StartupObservation.CreateForService(args[1]);
            try { _ = BeginObservedStart(AppContext.BaseDirectory, observation); }
            catch { observation.Dispose(); throw; }
            return;
        }
        lock (startupSync)
        {
            if (startupSelected || stopRequested) throw new InvalidOperationException("The service startup is already selected or stopped.");
            startupSelected = true;
        }
        Program.StartWorker(AppContext.BaseDirectory, session);
        lock (startupSync) stopObservation = Task.Run(StopWhenCompleteAsync);
    }

    internal Task BeginObservedStart(string baseDirectory, StartupObservation observation)
    {
        ArgumentNullException.ThrowIfNull(observation);
        lock (startupSync)
        {
            if (startupSelected || stopRequested) throw new InvalidOperationException("The service startup is already selected or stopped.");
            startupSelected = true;
            var startup = Task.Run(() => Program.StartWorker(baseDirectory, session, observation));
            stopObservation = Task.Run(() => ObserveStartupLifetimeAsync(startup, observation));
            return startup;
        }
    }

    private async Task ObserveStartupLifetimeAsync(Task startup, StartupObservation observation)
    {
        Exception? firstFailure = null;
        try
        {
            try { await startup.ConfigureAwait(false); }
            catch (Exception failure) { firstFailure = failure; ExitCode = 1; }
            // An observation failure after Resume does not authorize stopping the original worker.
            try { await session.Completion.ConfigureAwait(false); }
            catch (Exception failure) { firstFailure ??= failure; ExitCode = 1; }
        }
        finally
        {
            try { observation.Dispose(); }
            catch (Exception failure) { firstFailure ??= failure; ExitCode = 1; }
        }
        try { Stop(); }
        catch (Exception failure) { firstFailure ??= failure; ExitCode = 1; }
        if (firstFailure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(firstFailure).Throw();
    }

    private async Task StopWhenCompleteAsync()
    {
        try { await session.Completion.ConfigureAwait(false); }
        catch (Exception) { ExitCode = 1; }
        Stop();
    }

    private void StopSession()
    {
        lock (startupSync) stopRequested = true;
        try { session.GracefulStopAsync().GetAwaiter().GetResult(); }
        catch (Exception) { ExitCode = 1; }
    }

    protected override void OnStop() => StopSession();
    protected override void OnShutdown() => StopSession();
}
