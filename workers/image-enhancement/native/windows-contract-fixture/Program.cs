using System.Collections.ObjectModel;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsContractFixture;

internal static class Program
{
    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static async Task<int> Main(string[] args)
    {
        using var stdout = new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true };
        using var stderr = new StreamWriter(Console.OpenStandardError(), Utf8) { AutoFlush = true };
        try
        {
            if (!OperatingSystem.IsWindows() || args.Length != 1 || args[0] is not ("control" or "parse"))
                throw new InvalidOperationException();
            using var stdin = new StreamReader(Console.OpenStandardInput(), Utf8, detectEncodingFromByteOrderMarks: false);
            using var carrier = JsonDocument.Parse(await stdin.ReadToEndAsync());
            var root = carrier.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new InvalidOperationException();
            var fields = root.EnumerateObject().ToArray();
            if (fields.Length != 2 || fields.Select(x => x.Name).Distinct(StringComparer.Ordinal).Count() != 2 ||
                !fields.All(x => (x.Name is "requestUtf8Base64" or "requestFingerprint") && x.Value.ValueKind == JsonValueKind.String))
                throw new InvalidOperationException();
            string requestUtf8Base64 = root.GetProperty("requestUtf8Base64").GetString()!;
            string requestFingerprint = root.GetProperty("requestFingerprint").GetString()!;
            var core = typeof(PreparePayload).Assembly;
            var loadedCore = new
            {
                name = core.GetName().Name,
                hasPrepareForTest = typeof(JobProcess).GetMethod("PrepareForTest") is not null,
                hasFailureEnum = core.GetType("Zeb.WindowsSupervisor.PrepareFailurePoint") is not null,
            };
            if (args[0] == "control")
            {
                // Independent BCL transport control; never calls production Parse.
                byte[] bytes = Convert.FromBase64String(requestUtf8Base64);
                string raw = Utf8.GetString(bytes);
                string rawSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
                await stdout.WriteLineAsync(JsonSerializer.Serialize(new
                {
                    accepted = true,
                    mode = "control",
                    loadedCore,
                    rawSha256,
                    fingerprintMatches = rawSha256 == requestFingerprint,
                    canonicalBase64 = Convert.ToBase64String(bytes) == requestUtf8Base64,
                    utf8RoundTrip = Utf8.GetBytes(raw).AsSpan().SequenceEqual(bytes),
                    byteLength = bytes.Length,
                }, Json));
                return 0;
            }
            PreparePayload parsed;
            try { parsed = PreparePayload.Parse(requestUtf8Base64, requestFingerprint); }
            catch (ArgumentException error)
            {
                await stdout.WriteLineAsync(JsonSerializer.Serialize(new
                {
                    accepted = false,
                    mode = "parse",
                    loadedCore,
                    errorType = error.GetType().Name,
                    message = error.Message,
                    parameterName = error.ParamName,
                    hasInnerException = error.InnerException is not null,
                }, Json));
                return 0;
            }
            long[] before = parsed.AllowedTiles.ToArray();
            bool mutationRejected = false;
            if (parsed.AllowedTiles is IList<long> list && list.Count > 0)
            {
                try { list[0] = list[0] == 0 ? 32 : 0; }
                catch (NotSupportedException) { mutationRejected = true; }
            }
            var properties = typeof(PreparePayload).GetProperties(BindingFlags.Instance | BindingFlags.Public);
            await stdout.WriteLineAsync(JsonSerializer.Serialize(new
            {
                accepted = true,
                mode = "parse",
                loadedCore,
                value = new
                {
                    parsed.Scope, parsed.Engine, parsed.Limits, parsed.AllowedTiles,
                    parsed.FirstStartedAt, parsed.ExecutionDeadlineAt,
                    parsed.InputPath, parsed.WorkingDirectory, parsed.OutputPath,
                    parsed.RequestUtf8Base64, parsed.RequestFingerprint,
                },
                immutable = new
                {
                    publicPropertyCount = properties.Length,
                    gettersOnly = properties.All(x => x.GetMethod?.IsPublic == true && x.SetMethod is null),
                    noPublicConstructor = typeof(PreparePayload).GetConstructors().Length == 0,
                    readOnlyTiles = parsed.AllowedTiles is ReadOnlyCollection<long>,
                    mutationRejected,
                    tilesUnchanged = parsed.AllowedTiles.SequenceEqual(before),
                },
            }, Json));
            return 0;
        }
        catch
        {
            await stderr.WriteLineAsync("Contract fixture failed.");
            return 1;
        }
    }
}
