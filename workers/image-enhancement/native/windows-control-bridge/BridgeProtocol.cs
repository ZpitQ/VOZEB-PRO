using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsControlBridge;

internal sealed record BridgeLimits(int MaxRequestFrameBytes, int MaxResponseFrameBytes,
    int MaxHelperStderrBytes, int MaxSessionInputBytes, int MaxSessionOutputBytes,
    int MaxQueuedOutputBytes, int MaxJsonDepth, int StartupTimeoutMs, int RequestTimeoutMs,
    int SessionTimeoutMs, int CleanupTimeoutMs);

internal sealed record BridgeConfiguration(string HelperPath, string RecordsRoot,
    string InstallationRoot, string ExpectedManifestSha256,
    IReadOnlyDictionary<string, string> Environment, BridgeLimits Limits);

internal sealed record BridgeCommand(string RequestId, string Op, string ExecutionId,
    JsonElement? Payload = null, string? RequestFingerprint = null, PreparePayload? Prepare = null,
    bool IsPermit = false, bool? Allow = null, bool ObserveRuntime = false);
internal sealed record NativeMessage(string Kind, string? RequestId, string? Op, string? Role,
    string? ExecutionId, JsonElement? State, PrepareDiagnostic? Diagnostic = null);

internal static class BridgeProtocol
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    // The full state descriptor has six JSON containers plus converted CLR scalars.
    // This output-schema depth is separate from CLI and input parsing limits.
    private static readonly JsonSerializerOptions Json = new() { MaxDepth = 7 };

    internal static BridgeConfiguration Configuration(string[] args)
    {
        if (args.Length != 2 || args[0] != "--control-bridge") throw new InvalidDataException();
        RequireUnicode(args[1]);
        // The trusted scalar argument has the Windows command-line bound. The
        // fixed schema itself needs two object levels; stdin cannot set quotas.
        using JsonDocument document = Parse(Utf8.GetBytes(args[1]), 2);
        JsonElement root = document.RootElement;
        Exact(root, "v", "helperPath", "recordsRoot", "installationRoot", "expectedManifestSha256", "environment", "limits");
        Version(root);
        string helper = Text(root, "helperPath"), records = Text(root, "recordsRoot"), installation = Text(root, "installationRoot");
        LocalPath(helper); LocalPath(records); LocalPath(installation);
        if (!Path.GetExtension(helper).Equals(".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        string manifest = Text(root, "expectedManifestSha256");
        if (!Hex(manifest, 64)) throw new InvalidDataException();
        JsonElement environmentValue = root.GetProperty("environment");
        if (environmentValue.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (JsonProperty value in environmentValue.EnumerateObject())
        {
            RequireUnicode(value.Name);
            if (value.Name.Length == 0 || value.Name.Contains('=') || value.Value.ValueKind != JsonValueKind.String)
                throw new InvalidDataException();
            string text = value.Value.GetString()!;
            RequireUnicode(text);
            if (!environment.TryAdd(value.Name, text)) throw new InvalidDataException();
        }
        JsonElement quotas = root.GetProperty("limits");
        Exact(quotas, "maxRequestFrameBytes", "maxResponseFrameBytes", "maxHelperStderrBytes",
            "maxSessionInputBytes", "maxSessionOutputBytes", "maxQueuedOutputBytes", "maxJsonDepth",
            "startupTimeoutMs", "requestTimeoutMs", "sessionTimeoutMs", "cleanupTimeoutMs");
        int ByteLimit(string name) => Positive(quotas, name, Array.MaxLength);
        var limits = new BridgeLimits(ByteLimit("maxRequestFrameBytes"), ByteLimit("maxResponseFrameBytes"),
            ByteLimit("maxHelperStderrBytes"), ByteLimit("maxSessionInputBytes"), ByteLimit("maxSessionOutputBytes"),
            ByteLimit("maxQueuedOutputBytes"), Positive(quotas, "maxJsonDepth", int.MaxValue),
            Positive(quotas, "startupTimeoutMs", int.MaxValue), Positive(quotas, "requestTimeoutMs", int.MaxValue),
            Positive(quotas, "sessionTimeoutMs", int.MaxValue), Positive(quotas, "cleanupTimeoutMs", int.MaxValue));
        if (limits.MaxJsonDepth < 2 || limits.MaxRequestFrameBytes > limits.MaxSessionInputBytes ||
            limits.MaxResponseFrameBytes > limits.MaxSessionOutputBytes || limits.MaxResponseFrameBytes > limits.MaxQueuedOutputBytes)
            throw new InvalidDataException();
        return new(helper, records, installation, manifest, new ReadOnlyDictionary<string, string>(environment), limits);
    }

    internal static BridgeCommand Command(ReadOnlyMemory<byte> bytes, int depth)
    {
        using JsonDocument document = Parse(bytes, depth);
        JsonElement value = document.RootElement;
        Version(value);
        string id = Text(value, "requestId"), execution = Text(value, "executionId"), op = Text(value, "op");
        if (!Hex(id, 32) || !Hex(execution, 32)) throw new InvalidDataException();
        string kind = Text(value, "kind");
        if (kind == "permit")
        {
            Exact(value, "v", "kind", "requestId", "op", "executionId", "requestFingerprint", "allow");
            string fingerprint = Text(value, "requestFingerprint");
            JsonElement allow = value.GetProperty("allow");
            if (op is not ("prepare" or "authorize" or "request-stop") || !Hex(fingerprint, 64) ||
                allow.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidDataException();
            return new(id, op, execution, RequestFingerprint: fingerprint, IsPermit: true, Allow: allow.GetBoolean());
        }
        if (kind != "command") throw new InvalidDataException();
        if (op is "prepare" or "authorize" or "request-stop")
        {
            if (depth < 6) throw new InvalidDataException();
            string fingerprint = Text(value, "requestFingerprint");
            if (!Hex(fingerprint, 64)) throw new InvalidDataException();
            if (op == "prepare")
            {
                Exact(value, "v", "kind", "requestId", "op", "executionId", "requestUtf8Base64", "requestFingerprint");
                string carrier = Text(value, "requestUtf8Base64");
                // Bound hidden JSON depth/duplicates before reusing the authoritative semantic parser.
                using JsonDocument decoded = Parse(Convert.FromBase64String(carrier), depth);
                PreparePayload prepare = PreparePayload.Parse(carrier, fingerprint);
                bool observe = decoded.RootElement.TryGetProperty("runtimeObservation", out JsonElement marker) && marker.GetString() == "boot-v1";
                return new(id, op, execution, value.Clone(), fingerprint, prepare, ObserveRuntime: observe);
            }
            if (op == "request-stop")
            {
                Exact(value, "v", "kind", "requestId", "op", "executionId", "target", "descriptor", "requestFingerprint", "mode", "stopRequestedAt", "terminateAfterAt");
                if (Text(value, "mode") is not ("soft" or "force") || StopInteger(value.GetProperty("terminateAfterAt")) <= StopInteger(value.GetProperty("stopRequestedAt"))) throw new InvalidDataException();
            }
            else Exact(value, "v", "kind", "requestId", "op", "executionId", "target", "descriptor", "requestFingerprint");
            JsonElement target = value.GetProperty("target"), descriptor = Descriptor(value.GetProperty("descriptor"));
            Target(target);
            if (Text(descriptor, "executionId") != execution ||
                Text(descriptor.GetProperty("details"), "requestFingerprint") != fingerprint ||
                !JsonElement.DeepEquals(target, descriptor.GetProperty("details").GetProperty("target"))) throw new InvalidDataException();
            return new(id, op, execution, value.Clone(), fingerprint);
        }
        Exact(value, "v", "kind", "requestId", "op", "executionId");
        if (op is not ("inspect" or "close"))
            throw new InvalidDataException();
        return new(id, op, execution);
    }

    internal static string Ready(ReadOnlyMemory<byte> bytes, int depth)
    {
        using JsonDocument document = Parse(bytes, depth);
        JsonElement value = document.RootElement;
        Exact(value, "v", "kind", "executionId");
        Version(value);
        string execution = Text(value, "executionId");
        if (Text(value, "kind") != "ready" || !Hex(execution, 32)) throw new InvalidDataException();
        return execution;
    }

    internal static NativeMessage Native(ReadOnlyMemory<byte> bytes, int depth)
    {
        using JsonDocument document = Parse(bytes, depth);
        JsonElement value = document.RootElement;
        string kind = Text(value, "kind");
        if (kind == "error")
        {
            bool hasDiagnostic = value.TryGetProperty("prepareDiagnostic", out JsonElement diagnostic);
            if (hasDiagnostic) Exact(value, "v", "kind", "requestId", "code", "prepareDiagnostic");
            else Exact(value, "v", "kind", "requestId", "code");
            Version(value);
            string id = Text(value, "requestId"), code = Text(value, "code");
            if (!Hex(id, 32) || code.Length == 0) throw new InvalidDataException();
            return new(kind, id, null, null, null, null, hasDiagnostic ? PrepareDiagnostic.Parse(diagnostic) : null);
        }
        if (kind == "event")
        {
            Exact(value, "v", "kind", "event", "executionId", "state");
            Version(value);
            string execution = Text(value, "executionId");
            if (Text(value, "event") != "state" || !Hex(execution, 32)) throw new InvalidDataException();
            return new(kind, null, null, null, execution, Snapshot(value.GetProperty("state"), execution));
        }
        Exact(value, "v", "kind", "requestId", "op", "executionId", "role", "state");
        Version(value);
        string request = Text(value, "requestId"), operation = Text(value, "op"), target = Text(value, "executionId"), role = Text(value, "role");
        if (kind != "response" || !Hex(request, 32) || !Hex(target, 32) ||
            operation is not ("claim" or "watch" or "inspect" or "stop" or "prepare" or "authorize" or "request-stop") || role is not ("owner" or "observer"))
            throw new InvalidDataException();
        return new(kind, request, operation, role, target, Snapshot(value.GetProperty("state"), target));
    }

    private static JsonElement Snapshot(JsonElement value, string execution)
    {
        bool hasObservation = value.TryGetProperty("runtimeObservation", out JsonElement observation);
        if (hasObservation) Exact(value, "phase", "sealReason", "requestFingerprint", "descriptor", "authorizationVerified", "resumeState", "evidenceOutcome", "completion", "runtimeObservation");
        else Exact(value, "phase", "sealReason", "requestFingerprint", "descriptor", "authorizationVerified", "resumeState", "evidenceOutcome", "completion");
        string phase = Text(value, "phase"), evidence = Text(value, "evidenceOutcome");
        JsonElement reasonValue = value.GetProperty("sealReason");
        string? reason = reasonValue.ValueKind == JsonValueKind.Null ? null : Text(value, "sealReason");
        string? fingerprint = value.GetProperty("requestFingerprint").ValueKind == JsonValueKind.Null ? null : Text(value, "requestFingerprint");
        JsonElement? descriptor = value.GetProperty("descriptor").ValueKind == JsonValueKind.Null ? null : Descriptor(value.GetProperty("descriptor"));
        JsonElement authorization = value.GetProperty("authorizationVerified");
        if (authorization.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            (fingerprint is not null && !Hex(fingerprint, 64))) throw new InvalidDataException();
        bool authorized = authorization.GetBoolean();
        string resume = Text(value, "resumeState");
        string? completion = value.GetProperty("completion").ValueKind == JsonValueKind.Null ? null : Text(value, "completion");
        if (resume is not ("not-attempted" or "uncertain" or "succeeded") ||
            (descriptor is JsonElement owner && (Text(owner, "executionId") != execution || Text(owner.GetProperty("details"), "requestFingerprint") != fingerprint)) ||
            ((authorized || resume != "not-attempted") && (descriptor is null || fingerprint is null)) ||
            (resume != "not-attempted" && !authorized)) throw new InvalidDataException();
        if ((reason == "engine-exit" && (!authorized || resume != "succeeded")) ||
            ((reason is "deadline" or "launch-failure") && fingerprint is null)) throw new InvalidDataException();
        bool initial = (phase is "claimed" or "unclaimed") && reason is null && evidence == "pending" &&
            fingerprint is null && descriptor is null && !authorized && resume == "not-attempted" && completion is null;
        bool active = reason is null && evidence == "pending" && completion is null && (
            (phase == "preparing" && fingerprint is not null && !authorized && resume == "not-attempted") ||
            (phase == "prepared" && descriptor is not null && !authorized && resume == "not-attempted") ||
            (phase == "authorizing" && descriptor is not null && resume == "not-attempted") ||
            (phase == "running" && descriptor is not null && authorized && resume == "succeeded"));
        bool reasonValid = reason is "stop" or "controller_exit" or "controller_eof" or "control_write_failure" or "deadline" or "launch-failure" or "engine-exit" or "evidence-unknown";
        bool seal = phase == "sealed" && reasonValid && reason != "evidence-unknown" && evidence == "pending" && completion is null;
        bool unknown = phase == "unknown" && reasonValid && evidence == "unknown" && completion is null;
        bool loss = reason is "controller_exit" or "controller_eof" or "control_write_failure";
        bool terminal = phase == "terminal" && fingerprint is not null && evidence == "verified" && (
            (completion == "engine-exit" && reason == "engine-exit" && authorized && resume == "succeeded") ||
            (completion == "interrupted" && loss && authorized) ||
            (completion == "unauthorized-cleanup" && loss && !authorized && resume == "not-attempted") ||
            (completion == "launch-failure" && reason == "launch-failure") ||
            ((completion is "stop" or "deadline") && reason == completion));
        if (!(initial || active || seal || unknown || terminal)) throw new InvalidDataException();
        if (hasObservation && observation.ValueKind != JsonValueKind.Null)
        {
            if (descriptor is null || fingerprint is null) throw new InvalidDataException();
            ValidateObservation(observation, descriptor.Value);
            return WithRuntimeObservation(value, observation);
        }
        return WithRuntimeObservation(value, null);
    }

    private static void ValidateObservation(JsonElement value, JsonElement descriptor)
    {
        try
        {
            Exact(value, "v", "background", "engine", "gpu"); Version(value);
            if (value.GetProperty("background").ValueKind != JsonValueKind.Null) throw new InvalidDataException();
            JsonElement engine = value.GetProperty("engine");
            if (engine.ValueKind != JsonValueKind.Null)
            {
                if (Text(engine, "state") == "unknown") UnknownFact(engine);
                else
                {
                    Exact(engine, "state", "process");
                    if (Text(engine, "state") != "observed") throw new InvalidDataException();
                    JsonElement process = engine.GetProperty("process");
                    Exact(process, "pid", "creationFileTime", "userSid", "sessionId");
                    Unsigned(process.GetProperty("pid"), uint.MaxValue);
                    string time = Text(process, "creationFileTime");
                    if (time.Length == 0 || time[0] == '0' || !ulong.TryParse(time, NumberStyles.None, CultureInfo.InvariantCulture, out ulong parsed) ||
                        parsed.ToString(CultureInfo.InvariantCulture) != time) throw new InvalidDataException();
                    string sid = Text(process, "userSid");
                    if (new SecurityIdentifier(sid).Value != sid || ZeroUnsigned(process.GetProperty("sessionId")) != 0)
                        throw new InvalidDataException();
                    JsonElement original = descriptor.GetProperty("details").GetProperty("engine");
                    if (!JsonElement.DeepEquals(process.GetProperty("pid"), original.GetProperty("pid")) ||
                        !JsonElement.DeepEquals(process.GetProperty("creationFileTime"), original.GetProperty("creationFileTime"))) throw new InvalidDataException();
                }
            }
            JsonElement gpu = value.GetProperty("gpu");
            string state = Text(gpu, "state");
            if (state == "unknown") { UnknownFact(gpu); return; }
            if (state is "not-started" or "pending") { Exact(gpu, "state"); return; }
            if (state != "observed") throw new InvalidDataException();
            Exact(gpu, "state", "driverVersion", "devices"); Identifier(Text(gpu, "driverVersion"));
            JsonElement devices = gpu.GetProperty("devices");
            if (devices.ValueKind != JsonValueKind.Array || devices.GetArrayLength() == 0) throw new InvalidDataException();
            uint? previous = null;
            foreach (JsonElement device in devices.EnumerateArray())
            {
                Exact(device, "nvmlIndex", "name", "uuid", "graphics", "compute");
                uint index = ZeroUnsigned(device.GetProperty("nvmlIndex"));
                if (previous is uint old && index <= old) throw new InvalidDataException();
                previous = index; Identifier(Text(device, "name"));
                if (device.GetProperty("uuid").ValueKind != JsonValueKind.Null) Identifier(Text(device, "uuid"));
                JsonElement graphics = device.GetProperty("graphics"), compute = device.GetProperty("compute");
                if (graphics.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                    compute.ValueKind is not (JsonValueKind.True or JsonValueKind.False) || !graphics.GetBoolean() && !compute.GetBoolean())
                    throw new InvalidDataException();
            }
        }
        catch (Exception failure) when (failure is KeyNotFoundException or InvalidOperationException or ArgumentException or OverflowException)
        { throw new InvalidDataException("Invalid runtime observation.", failure); }
    }

    private static uint ZeroUnsigned(JsonElement value)
    {
        string raw = value.GetRawText();
        if (value.ValueKind != JsonValueKind.Number || !uint.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out uint result) ||
            result.ToString(CultureInfo.InvariantCulture) != raw) throw new InvalidDataException();
        return result;
    }
    private static void UnknownFact(JsonElement value)
    {
        Exact(value, "state", "reason");
        if (Text(value, "state") != "unknown" || Text(value, "reason") is not
            ("unsupported" or "unavailable" or "permission" or "identity" or "no-match" or "incomplete" or "deadline")) throw new InvalidDataException();
    }
    private static JsonElement WithRuntimeObservation(JsonElement state, JsonElement? observation)
    {
        var fields = state.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone(), StringComparer.Ordinal);
        fields["runtimeObservation"] = observation ?? JsonSerializer.SerializeToElement<object?>(null, Json);
        return JsonSerializer.SerializeToElement(fields, Json);
    }
    internal static JsonElement BindRuntimeObservation(JsonElement state, JsonElement background, string helperUser)
    {
        JsonElement observation = state.GetProperty("runtimeObservation"), engine = observation.GetProperty("engine");
        if (engine.ValueKind == JsonValueKind.Object && Text(engine, "state") == "observed")
        {
            JsonElement process = engine.GetProperty("process");
            bool same = Text(process, "userSid") == helperUser;
            if (Text(background, "state") == "observed")
            {
                JsonElement worker = background.GetProperty("worker");
                same &= Text(process, "userSid") == Text(worker, "userSid") &&
                    JsonElement.DeepEquals(process.GetProperty("sessionId"), worker.GetProperty("sessionId"));
            }
            if (!same) engine = JsonSerializer.SerializeToElement(new { state = "unknown", reason = "identity" }, Json);
        }
        JsonElement bound = JsonSerializer.SerializeToElement(new { v = 1, background, engine, gpu = observation.GetProperty("gpu") }, Json);
        return WithRuntimeObservation(state, bound);
    }

    private static void Target(JsonElement target)
    {
        Exact(target, "identity", "launchTicket"); Identifier(Text(target, "launchTicket"));
        JsonElement identity = target.GetProperty("identity");
        Exact(identity, "jobId", "attemptNo", "ownerInstanceId", "fence");
        Identifier(Text(identity, "jobId")); Identifier(Text(identity, "ownerInstanceId"));
        Unsigned(identity.GetProperty("attemptNo"), 9007199254740991); Unsigned(identity.GetProperty("fence"), 9007199254740991);
    }

    internal static JsonElement Descriptor(JsonElement value)
    {
        Exact(value, "adapterId", "launchTicket", "executionId", "details");
        JsonElement details = value.GetProperty("details");
        Exact(details, "v", "target", "executionPolicyFingerprint", "requestFingerprint", "requestRecordId", "preparedRecordId",
            "recipeId", "installationManifestSha256", "supervisor", "engine", "jobName");
        Version(details); Target(details.GetProperty("target"));
        if (Text(value, "adapterId") != "windows-supervisor-v1" || !Hex(Text(value, "executionId"), 32) ||
            Text(value, "launchTicket") != Text(details.GetProperty("target"), "launchTicket") ||
            Text(details, "requestRecordId") != "00000000000000000000000000000001" ||
            Text(details, "preparedRecordId") != "00000000000000000000000000000002" || Text(details, "recipeId") != "upscayl-4x-png-v1") throw new InvalidDataException();
        foreach (string name in new[] { "executionPolicyFingerprint", "requestFingerprint", "installationManifestSha256" })
            if (!Hex(Text(details, name), 64)) throw new InvalidDataException();
        foreach (string role in new[] { "supervisor", "engine" })
        {
            JsonElement identity = details.GetProperty(role); Exact(identity, "pid", "creationFileTime");
            Unsigned(identity.GetProperty("pid"), uint.MaxValue);
            string time = Text(identity, "creationFileTime");
            if (time.Length == 0 || time[0] == '0' || !ulong.TryParse(time, NumberStyles.None, CultureInfo.InvariantCulture, out ulong parsed) ||
                parsed.ToString(CultureInfo.InvariantCulture) != time) throw new InvalidDataException();
        }
        Identifier(Text(details, "jobName"));
        return value.Clone();
    }

    private static void Unsigned(JsonElement value, ulong maximum)
    {
        string token = value.GetRawText();
        if (value.ValueKind != JsonValueKind.Number || token.Length == 0 || token[0] is < '1' or > '9' ||
            !ulong.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out ulong number) || number > maximum) throw new InvalidDataException();
    }

    private static long StopInteger(JsonElement value)
    {
        string token = value.GetRawText();
        if (value.ValueKind != JsonValueKind.Number || !long.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out long number) ||
            number < 0 || number > 9007199254740991 || number.ToString(CultureInfo.InvariantCulture) != token) throw new InvalidDataException();
        return number;
    }

    private static void Identifier(string value)
    {
        RequireUnicode(value);
        const string whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
        if (value.Length == 0 || whitespace.Contains(value[0]) || whitespace.Contains(value[^1]) || value.Any(character => character <= 0x1f || character == 0x7f)) throw new InvalidDataException();
    }

    internal static byte[] NativeRequest(string id, string op, string execution)
    {
        if (!Hex(id, 32) || !Hex(execution, 32) || op is not ("claim" or "watch" or "inspect" or "stop"))
            throw new InvalidDataException();
        return Frame(new { v = 1, requestId = id, op, executionId = execution });
    }

    internal static byte[] NativeRequest(BridgeCommand command)
    {
        if (command.Payload is not JsonElement payload || command.Op is not ("prepare" or "authorize" or "request-stop")) throw new InvalidDataException();
        return Frame(payload.EnumerateObject().Where(property => property.Name != "kind")
            .ToDictionary(property => property.Name, property => property.Value.Clone(), StringComparer.Ordinal));
    }

    internal static byte[] PermitRequest(string id, string op, string execution, string fingerprint) =>
        Frame(new { v = 1, kind = "permit-request", requestId = id, op, executionId = execution, requestFingerprint = fingerprint });
    internal static byte[] Ending(string execution) => Frame(new { v = 1, kind = "ending", executionId = execution });

    internal static byte[] Bound(string execution, OriginalProcessPin bridge, OriginalProcessPin helper, JsonElement state) =>
        Frame(new { v = 1, kind = "bound", executionId = execution, bridge = bridge.WireIdentity, helper = helper.WireIdentity, state });
    internal static byte[] State(string? requestId, string execution, JsonElement state) =>
        Frame(new { v = 1, kind = "state", requestId, executionId = execution, state });
    internal static byte[] Unknown(string? requestId, string? execution, PrepareDiagnostic? diagnostic = null) =>
        diagnostic is null ? Frame(new { v = 1, kind = "unknown", requestId, executionId = execution })
            : Frame(new { v = 1, kind = "unknown", requestId, executionId = execution, prepareDiagnostic = diagnostic });
    internal static byte[] Closed(string? requestId, string? execution, bool stopped) =>
        Frame(new { v = 1, kind = "closed", requestId, executionId = execution, outcome = stopped ? "stopped" : "unknown" });

    private static byte[] Frame(object value)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        Array.Resize(ref bytes, checked(bytes.Length + 1));
        bytes[^1] = (byte)'\n';
        return bytes;
    }

    private static JsonDocument Parse(ReadOnlyMemory<byte> bytes, int depth)
    {
        if (bytes.IsEmpty || (bytes.Length >= 3 && bytes.Span[0] == 0xef && bytes.Span[1] == 0xbb && bytes.Span[2] == 0xbf))
            throw new InvalidDataException();
        // JsonDocument supplies syntax/depth; fatal UTF8 and decoded duplicate
        // names are additional wire invariants, including names inside children.
        Utf8.GetCharCount(bytes.Span);
        JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions
        {
            MaxDepth = depth, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow,
        });
        try
        {
            NoDuplicates(document.RootElement);
            return document;
        }
        catch { document.Dispose(); throw; }
    }

    private static void NoDuplicates(JsonElement value)
    {
        var pending = new Stack<JsonElement>();
        pending.Push(value);
        while (pending.TryPop(out JsonElement current))
        {
            if (current.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (JsonProperty property in current.EnumerateObject())
                {
                    RequireUnicode(property.Name);
                    if (!names.Add(property.Name)) throw new InvalidDataException();
                    pending.Push(property.Value);
                }
            }
            else if (current.ValueKind == JsonValueKind.Array)
                foreach (JsonElement item in current.EnumerateArray()) pending.Push(item);
            else if (current.ValueKind == JsonValueKind.String) RequireUnicode(current.GetString()!);
        }
    }

    private static void Exact(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        int count = 0;
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!keys.Contains(property.Name, StringComparer.Ordinal)) throw new InvalidDataException();
            count++;
        }
        if (count != keys.Length) throw new InvalidDataException();
    }

    private static void Version(JsonElement value)
    {
        if (value.GetProperty("v").ValueKind != JsonValueKind.Number || value.GetProperty("v").GetRawText() != "1")
            throw new InvalidDataException();
    }

    private static string Text(JsonElement value, string name)
    {
        JsonElement field = value.GetProperty(name);
        if (field.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        string text = field.GetString()!;
        RequireUnicode(text);
        return text;
    }

    private static int Positive(JsonElement value, string name, int maximum)
    {
        JsonElement field = value.GetProperty(name);
        if (field.ValueKind != JsonValueKind.Number) throw new InvalidDataException();
        string raw = field.GetRawText();
        if (raw.Length == 0 || raw[0] is < '1' or > '9' || raw.Any(character => character is < '0' or > '9') ||
            !int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed) || parsed > maximum)
            throw new InvalidDataException();
        return parsed;
    }

    private static void LocalPath(string value)
    {
        RequireUnicode(value);
        if (value.Length < 3 || !char.IsAsciiLetter(value[0]) || value[1] != ':' || value[2] is not ('\\' or '/') ||
            !Path.IsPathFullyQualified(value)) throw new InvalidDataException();
    }

    private static void RequireUnicode(string value)
    {
        if (value.Contains('\0')) throw new InvalidDataException();
        Utf8.GetByteCount(value);
    }

    internal static bool Hex(string value, int length) => value.Length == length &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}

internal enum FrameJoin { Eof, LocalCancellation, ProofGap }

internal static class BoundedFrameReader
{
    internal static async Task<FrameJoin> ReadAsync(Stream source, int frameCap, int? totalCap,
        bool readyCrLf, Action<ReadOnlyMemory<byte>> frame, Action fault,
        CancellationToken cancellation, Func<bool> locallyClosing)
    {
        byte[] buffer = new byte[Math.Min(4096, frameCap)];
        byte[] current = new byte[frameCap];
        int used = 0;
        long total = 0;
        bool capturing = true;
        try
        {
            while (true)
            {
                int read = await source.ReadAsync(buffer, cancellation);
                if (read == 0)
                {
                    if (capturing && used != 0) fault();
                    return FrameJoin.Eof;
                }
                if (totalCap is int cap)
                {
                    total = Math.Min((long)cap + 1, total + read);
                    if (total > cap && capturing) { capturing = false; used = 0; fault(); }
                }
                if (!capturing) continue;
                for (int index = 0; index < read; index++)
                {
                    byte value = buffer[index];
                    if (used == frameCap)
                    {
                        capturing = false; used = 0; fault(); break;
                    }
                    current[used++] = value;
                    if (value != (byte)'\n') continue;
                    int length = used - 1;
                    if (readyCrLf && length > 0 && current[length - 1] == (byte)'\r') length--;
                    try
                    {
                        if (length == 0 || current.AsSpan(0, length).Contains((byte)'\r')) throw new InvalidDataException();
                        frame(current.AsMemory(0, length));
                    }
                    catch { capturing = false; fault(); }
                    used = 0;
                    if (!capturing) break;
                }
            }
        }
        catch (Exception error) when (locallyClosing() && error is OperationCanceledException or ObjectDisposedException or IOException)
        {
            return FrameJoin.LocalCancellation;
        }
        catch { fault(); return FrameJoin.ProofGap; }
    }
}

// Only this writer touches bridge stdout. The budget includes the frame being
// written, queued frames and the latest pre-bound observer state.
internal sealed class BoundedOutputWriter
{
    private sealed record Pending(byte[] Bytes, TaskCompletionSource<bool> Completion);
    private readonly object gate = new();
    private readonly Stream output;
    private readonly BridgeLimits limits;
    private readonly Action failed;
    private readonly Queue<Pending> queue = new();
    private readonly SemaphoreSlim available = new(0);
    private byte[]? initial;
    private long accounted, admitted;
    private bool sealedOutput, failure;
    internal Task Completion { get; }

    internal BoundedOutputWriter(Stream output, BridgeLimits limits, Action failed)
    {
        this.output = output; this.limits = limits; this.failed = failed;
        Completion = Task.Run(WriteAsync);
    }

    internal bool RetainInitial(byte[] bytes)
    {
        lock (gate)
        {
            long old = initial?.Length ?? 0;
            if (sealedOutput || !Fits(bytes.Length, accounted - old, admitted)) return RejectLocked();
            accounted += bytes.Length - old;
            initial = bytes;
            return true;
        }
    }

    internal bool PublishBound(byte[] bytes)
    {
        lock (gate)
        {
            long retained = initial?.Length ?? 0;
            if (sealedOutput || !Fits(bytes.Length, accounted, admitted + retained)) return RejectLocked();
            AddLocked(bytes);
            // Queue order is bound, latest initial state, then live events.
            if (initial is not null)
            {
                byte[] value = initial; initial = null;
                accounted -= value.Length;
                AddLocked(value);
            }
            return true;
        }
    }

    internal Task<bool>? Enqueue(byte[] bytes)
    {
        lock (gate)
        {
            if (sealedOutput || !Fits(bytes.Length, accounted, admitted + (initial?.Length ?? 0)))
            {
                RejectLocked(); return null;
            }
            return AddLocked(bytes);
        }
    }

    private bool Fits(int length, long buffered, long total) => length <= limits.MaxResponseFrameBytes &&
        buffered + length <= limits.MaxQueuedOutputBytes && total + length <= limits.MaxSessionOutputBytes;

    private Task<bool> AddLocked(byte[] bytes)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.Enqueue(new(bytes, completion));
        accounted += bytes.Length; admitted += bytes.Length;
        available.Release();
        return completion.Task;
    }

    private bool RejectLocked()
    {
        failure = true;
        SealLocked();
        return false;
    }

    private void SealLocked()
    {
        if (sealedOutput) return;
        sealedOutput = true;
        if (initial is not null) { accounted -= initial.Length; initial = null; }
        available.Release();
    }

    internal void Seal() { lock (gate) SealLocked(); }
    internal bool Failed { get { lock (gate) return failure; } }

    private async Task WriteAsync()
    {
        while (true)
        {
            await available.WaitAsync();
            Pending? pending;
            lock (gate)
            {
                if (queue.Count == 0)
                {
                    if (sealedOutput) return;
                    continue;
                }
                pending = queue.Dequeue();
            }
            bool success;
            try
            {
                // There is no local cancellation that could masquerade as an
                // output join. A stuck writer retains the bridge owner.
                await output.WriteAsync(pending.Bytes);
                await output.FlushAsync();
                success = true;
            }
            catch { success = false; }
            lock (gate)
            {
                accounted -= pending.Bytes.Length;
                pending.Completion.TrySetResult(success);
                if (!success)
                {
                    failure = true; SealLocked();
                    while (queue.TryDequeue(out Pending? abandoned))
                    {
                        accounted -= abandoned.Bytes.Length;
                        abandoned.Completion.TrySetResult(false);
                    }
                }
            }
            if (!success) { failed(); return; }
        }
    }
}
