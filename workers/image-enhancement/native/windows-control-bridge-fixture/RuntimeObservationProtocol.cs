using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Zeb.WindowsControlBridgeFixture;

// The existing C# parser consumes the original bytes. No parser is copied here.
internal static class RuntimeObservationProtocol
{
    internal static async Task<int> RunAsync(string assemblyPath)
    {
        if (!Path.IsPathFullyQualified(assemblyPath)) throw new InvalidDataException("observation_bridge_path");
        string path = Path.GetFullPath(assemblyPath);
        var context = new AssemblyLoadContext("observation-protocol", isCollectible: true);
        try
        {
            context.LoadFromAssemblyPath(Path.Combine(Path.GetDirectoryName(path)!, "WindowsSupervisor.dll"));
            var assembly = context.LoadFromAssemblyPath(path);
            var protocol = assembly.GetType("Zeb.WindowsControlBridge.BridgeProtocol", throwOnError: true)!;
            var native = protocol.GetMethod("Native", BindingFlags.Static | BindingFlags.NonPublic,
                binder: null, types: [typeof(ReadOnlyMemory<byte>), typeof(int)], modifiers: null)
                ?? throw new InvalidDataException("observation_native_parser_missing");
            using var input = new MemoryStream();
            await Console.OpenStandardInput().CopyToAsync(input);
            bool accepted;
            JsonElement? state = null;
            try
            {
                object value = native.Invoke(null, [new ReadOnlyMemory<byte>(input.ToArray()), 6])
                    ?? throw new InvalidDataException("observation_native_result_missing");
                var property = value.GetType().GetProperty("State", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    ?? throw new InvalidDataException("observation_native_state_missing");
                state = (JsonElement?)property.GetValue(value);
                accepted = true;
            }
            catch (TargetInvocationException error) when (error.InnerException is InvalidDataException or JsonException or ArgumentException or FormatException or OverflowException)
            {
                accepted = false;
            }
            Console.OutputEncoding = new UTF8Encoding(false, true);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                kind = "runtime-observation-protocol", accepted, state,
                parser = "Zeb.WindowsControlBridge.BridgeProtocol.Native",
                assemblySha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))), depth = 6,
            }));
            return 0;
        }
        finally { context.Unload(); }
    }
}
