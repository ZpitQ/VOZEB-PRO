using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Zeb.WindowsSupervisor;

internal static class NativeRecoveryReader
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase, MaxDepth = int.MaxValue,
    };

    internal static async Task<int> RunAsync(string recordsRoot)
    {
        string stage = "input";
        try
        {
            using Stream input = Console.OpenStandardInput();
            using var bytes = new MemoryStream();
            await input.CopyToAsync(bytes);
            string text = Utf8.GetString(bytes.GetBuffer(), 0, checked((int)bytes.Length));
            using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions
            {
                MaxDepth = int.MaxValue, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false,
            });
            JsonElement query = document.RootElement;
            NativeExecutionSession.Exact(query, "v", "kind", "scope", "executionId");
            if (PositiveInteger(query.GetProperty("v")) != 1 ||
                NativeExecutionSession.Text(query, "kind") != "read-windows-journal")
                throw new InvalidDataException();
            JsonElement scope = query.GetProperty("scope");
            NativeExecutionSession.Exact(scope, "target", "executionPolicyFingerprint");
            JsonElement target = scope.GetProperty("target");
            NativeExecutionSession.Exact(target, "identity", "launchTicket");
            JsonElement identity = target.GetProperty("identity");
            NativeExecutionSession.Exact(identity, "jobId", "attemptNo", "ownerInstanceId", "fence");
            var expectedScope = new JournalScope(new JournalTarget(new JournalAttemptIdentity(
                NativeExecutionSession.Text(identity, "jobId"), PositiveInteger(identity.GetProperty("attemptNo")),
                NativeExecutionSession.Text(identity, "ownerInstanceId"), PositiveInteger(identity.GetProperty("fence"))),
                NativeExecutionSession.Text(target, "launchTicket")), NativeExecutionSession.Text(scope, "executionPolicyFingerprint"));
            string executionId = NativeExecutionSession.Text(query, "executionId");
            if (!NativeExecutionSession.Hex(executionId, 32)) throw new InvalidDataException();

            stage = "journal";
            ReadResult reservation = Result(ProtectedJournal.InspectReservation(recordsRoot, expectedScope));
            ReadResult request = Result(ProtectedJournal.Read(recordsRoot, expectedScope, executionId, "00000000000000000000000000000001"));
            ReadResult prepared = Result(ProtectedJournal.Read(recordsRoot, expectedScope, executionId, "00000000000000000000000000000002"));
            ReadResult authorization = Result(ProtectedJournal.Read(recordsRoot, expectedScope, executionId, "00000000000000000000000000000003"));
            ReadResult controllerLoss = Result(ProtectedJournal.Read(recordsRoot, expectedScope, executionId, "00000000000000000000000000000005"));
            ReadResult terminal = Result(ProtectedJournal.Read(recordsRoot, expectedScope, executionId, "00000000000000000000000000000006"));

            stage = "output";
            byte[] response = Utf8.GetBytes(JsonSerializer.Serialize(new
            {
                v = 1, kind = "windows-journal-snapshot", reservation,
                records = new { request, prepared, authorization, controllerLoss, terminal },
            }, Json) + "\n");
            using Stream output = Console.OpenStandardOutput();
            await output.WriteAsync(response);
            await output.FlushAsync();
            return 0;
        }
        catch
        {
            try { Console.Error.WriteLine(JsonSerializer.Serialize(new { code = "reader_failure", stage })); }
            catch { }
            return 2;
        }
    }

    private sealed record ReadResult(string Status, JsonElement? Snapshot);

    private static ReadResult Result(JournalResult result) => result.Status switch
    {
        JournalStatus.Existing when result.Snapshot is { } snapshot => new("existing", snapshot),
        JournalStatus.Unknown => new("unknown", null),
        _ => throw new InvalidDataException(),
    };

    private static long PositiveInteger(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out long number) ||
            number is <= 0 or > 9007199254740991 || value.GetRawText() != number.ToString(CultureInfo.InvariantCulture))
            throw new InvalidDataException();
        return number;
    }
}
