using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Zeb.WindowsSupervisor;

public sealed record PrepareLimits(long ExecutionTimeoutMs, long CancelGraceMs,
    long LeaseDurationMs, long HeartbeatIntervalMs);

public sealed class PreparePayload
{
    private const long MaxSafeInteger = 9007199254740991;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private PreparePayload(JournalScope scope, EngineSelection engine, PrepareLimits limits,
        long[] allowedTiles, long firstStartedAt, long executionDeadlineAt,
        string inputPath, string workingDirectory, string outputPath,
        string requestUtf8Base64, string requestFingerprint, string? runtimeObservation)
    {
        Scope = scope;
        Engine = engine;
        Limits = limits;
        AllowedTiles = Array.AsReadOnly(allowedTiles);
        FirstStartedAt = firstStartedAt;
        ExecutionDeadlineAt = executionDeadlineAt;
        InputPath = inputPath;
        WorkingDirectory = workingDirectory;
        OutputPath = outputPath;
        RequestUtf8Base64 = requestUtf8Base64;
        RequestFingerprint = requestFingerprint;
        RuntimeObservation = runtimeObservation;
    }

    public JournalScope Scope { get; }
    public EngineSelection Engine { get; }
    public PrepareLimits Limits { get; }
    public IReadOnlyList<long> AllowedTiles { get; }
    public long FirstStartedAt { get; }
    public long ExecutionDeadlineAt { get; }
    public string InputPath { get; }
    public string WorkingDirectory { get; }
    public string OutputPath { get; }
    public string RequestUtf8Base64 { get; }
    public string RequestFingerprint { get; }
    internal string? RuntimeObservation { get; }

    public static PreparePayload Parse(string requestUtf8Base64, string requestFingerprint)
    {
        try
        {
            if (!IsSha256(requestFingerprint)) throw InvalidArgument();
            byte[] bytes = Convert.FromBase64String(requestUtf8Base64);
            if (Convert.ToBase64String(bytes) != requestUtf8Base64) throw InvalidArgument();
            string text = Utf8.GetString(bytes);
            if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != requestFingerprint ||
                bytes.Length < 2 || bytes[0] != (byte)'{' || bytes[^1] != (byte)'}')
                throw InvalidArgument();
            using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions
            {
                MaxDepth = int.MaxValue, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false,
            });
            JsonElement root = document.RootElement;
            string[] rootKeys = ["v", "target", "executionPolicy", "engine", "firstStartedAt", "executionDeadlineAt",
                "inputPath", "workingDirectory", "outputPath"];
            string? runtimeObservation = null;
            if (root.TryGetProperty("runtimeObservation", out _))
            {
                runtimeObservation = Text(root, "runtimeObservation");
                if (runtimeObservation != "boot-v1") throw InvalidArgument();
                rootKeys = [.. rootKeys, "runtimeObservation"];
            }
            RequireKeys(root, rootKeys);
            if (Number(root.GetProperty("v")) != 1) throw InvalidArgument();

            JsonElement target = root.GetProperty("target");
            RequireKeys(target, "identity", "launchTicket");
            JsonElement identity = target.GetProperty("identity");
            RequireKeys(identity, "jobId", "attemptNo", "ownerInstanceId", "fence");
            var attempt = new JournalAttemptIdentity(Identifier(identity, "jobId"),
                Number(identity.GetProperty("attemptNo"), positive: true), Identifier(identity, "ownerInstanceId"),
                Number(identity.GetProperty("fence"), positive: true));
            var journalTarget = new JournalTarget(attempt, Identifier(target, "launchTicket"));

            JsonElement policy = root.GetProperty("executionPolicy");
            RequireKeys(policy, "limits", "allowedTiles", "fingerprint");
            JsonElement limitValues = policy.GetProperty("limits");
            RequireKeys(limitValues, "executionTimeoutMs", "cancelGraceMs", "leaseDurationMs", "heartbeatIntervalMs");
            var limits = new PrepareLimits(Number(limitValues.GetProperty("executionTimeoutMs"), positive: true),
                Number(limitValues.GetProperty("cancelGraceMs"), positive: true),
                Number(limitValues.GetProperty("leaseDurationMs"), positive: true),
                Number(limitValues.GetProperty("heartbeatIntervalMs"), positive: true));
            if (limits.HeartbeatIntervalMs > limits.LeaseDurationMs) throw InvalidArgument();
            var scope = new JournalScope(journalTarget, Sha256(policy, "fingerprint"));
            JsonElement tileValues = policy.GetProperty("allowedTiles");
            if (tileValues.ValueKind != JsonValueKind.Array || tileValues.GetArrayLength() == 0) throw InvalidArgument();
            var allowedTiles = new long[tileValues.GetArrayLength()];
            var seenTiles = new HashSet<long>();
            int index = 0;
            foreach (JsonElement item in tileValues.EnumerateArray())
            {
                long tile = Tile(item);
                if (!seenTiles.Add(tile)) throw InvalidArgument();
                allowedTiles[index++] = tile;
            }

            JsonElement engineValues = root.GetProperty("engine");
            RequireKeys(engineValues, "modelId", "binaryVersion", "binarySha256", "modelVersion", "modelSha256",
                "nativeScale", "tile", "tta", "gpuId");
            string modelId = Text(engineValues, "modelId");
            if (modelId.Length == 0 || !char.IsAsciiLetterOrDigit(modelId[0]) ||
                !modelId.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-'))
                throw InvalidArgument();
            long nativeScale = Number(engineValues.GetProperty("nativeScale"));
            long engineTile = Tile(engineValues.GetProperty("tile"));
            if (nativeScale != 4 || engineValues.GetProperty("tta").ValueKind != JsonValueKind.False ||
                !seenTiles.Contains(engineTile)) throw InvalidArgument();
            var engine = new EngineSelection(modelId, Identifier(engineValues, "binaryVersion"),
                Sha256(engineValues, "binarySha256"), Identifier(engineValues, "modelVersion"),
                Sha256(engineValues, "modelSha256"), nativeScale, engineTile, false, Number(engineValues.GetProperty("gpuId")));

            long firstStartedAt = Number(root.GetProperty("firstStartedAt"));
            long executionDeadlineAt = Number(root.GetProperty("executionDeadlineAt"));
            if (executionDeadlineAt <= firstStartedAt) throw InvalidArgument();
            return new PreparePayload(scope, engine, limits, allowedTiles, firstStartedAt, executionDeadlineAt,
                PathText(root, "inputPath"), PathText(root, "workingDirectory"), PathText(root, "outputPath"),
                requestUtf8Base64, requestFingerprint, runtimeObservation);
        }
        catch (Exception error) when (error is ArgumentException or FormatException or JsonException or
            InvalidOperationException or KeyNotFoundException or OverflowException)
        {
            throw InvalidArgument();
        }
    }

    private static void RequireKeys(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw InvalidArgument();
        var expected = new HashSet<string>(keys, StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            Utf8.GetByteCount(property.Name);
            if (!expected.Remove(property.Name)) throw InvalidArgument();
        }
        if (expected.Count != 0) throw InvalidArgument();
    }

    private static string Text(JsonElement value, string key)
    {
        JsonElement item = value.GetProperty(key);
        if (item.ValueKind != JsonValueKind.String) throw InvalidArgument();
        string text = item.GetString() ?? throw InvalidArgument();
        Utf8.GetByteCount(text);
        return text;
    }

    private static string Identifier(JsonElement value, string key)
    {
        string text = Text(value, key);
        if (text.Length == 0 || JsWhitespace(text[0]) || JsWhitespace(text[^1]) ||
            text.Any(character => character <= 0x1f || character == 0x7f)) throw InvalidArgument();
        return text;
    }

    private static string PathText(JsonElement value, string key)
    {
        string text = Text(value, key);
        if (text.Length == 0 || text.Contains('\0')) throw InvalidArgument();
        return text;
    }

    private static string Sha256(JsonElement value, string key)
    {
        string text = Text(value, key);
        if (!IsSha256(text)) throw InvalidArgument();
        return text;
    }

    private static long Tile(JsonElement value)
    {
        long tile = Number(value);
        if (tile != 0 && tile < 32) throw InvalidArgument();
        return tile;
    }

    private static long Number(JsonElement value, bool positive = false)
    {
        if (value.ValueKind != JsonValueKind.Number) throw InvalidArgument();
        string token = value.GetRawText();
        if (token.Length == 0 || (token[0] == '0' && token.Length != 1) ||
            token.Any(character => character is < '0' or > '9') ||
            !long.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out long number) ||
            number > MaxSafeInteger || (positive && number == 0)) throw InvalidArgument();
        return number;
    }

    private static bool IsSha256(string? value) => value is { Length: 64 } &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool JsWhitespace(char value) => value is >= '\u0009' and <= '\u000d' or '\u0020' or '\u00a0' or '\u1680' or
        >= '\u2000' and <= '\u200a' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff';

    private static ArgumentException InvalidArgument() => new("Invalid native prepare payload.");
}
