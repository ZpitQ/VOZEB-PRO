using System.Runtime.Versioning;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsControlBridge;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        BridgeConfiguration configuration;
        try
        {
            if (!OperatingSystem.IsWindows()) throw new InvalidDataException();
            configuration = BridgeProtocol.Configuration(args);
        }
        catch
        {
            // Do not echo configuration, paths, environment or parser diagnostics.
            Console.Error.WriteLine("control_bridge_invalid_configuration");
            return 2;
        }

        // RunAsync retains its original owner on an unresolved creation or join.
        // A catch/finally here must not turn that uncertainty into process exit.
        return await new OriginalControlSession(configuration).RunAsync();
    }
}
