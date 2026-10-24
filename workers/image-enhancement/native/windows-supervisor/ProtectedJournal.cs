using System.ComponentModel;
using System.Globalization;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsSupervisor;

public sealed record JournalAttemptIdentity(string JobId, long AttemptNo, string OwnerInstanceId, long Fence);
public sealed record JournalTarget(JournalAttemptIdentity Identity, string LaunchTicket);
public sealed record JournalScope(JournalTarget Target, string ExecutionPolicyFingerprint);
public enum JournalStatus { Created, Existing, Unknown }
public sealed record JournalDiagnostic(string Stage, int? NativeError);
public sealed record JournalResult(JournalStatus Status, JsonElement? Snapshot, ProtectedJournal? Owner, JournalDiagnostic? Diagnostic);

[SupportedOSPlatform("windows")]
public sealed class ProtectedJournal : IDisposable
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, MaxDepth = int.MaxValue };
    private readonly object gate = new();
    private readonly JournalRoot root;
    private readonly JournalScope scope;
    private readonly string executionId;
    private readonly string key;
    private readonly SafeFileHandle marker;
    private readonly JournalFileIdentity markerIdentity;
    private readonly List<SafeFileHandle> files = [];
    private readonly Dictionary<string, JournalDiagnostic> attempts = new(StringComparer.Ordinal);
    private bool disposed;

    private ProtectedJournal(JournalRoot root, JournalScope scope, string executionId, string key, SafeFileHandle marker)
    {
        this.root = root;
        this.scope = scope;
        this.executionId = executionId;
        this.key = key;
        this.marker = marker;
        markerIdentity = JournalNativeMethods.Identity(marker);
        files.Add(marker);
    }

    public static JournalResult Reserve(string recordsRoot, JournalScope scope, string executionId)
    {
        ValidateRootArgument(recordsRoot);
        string key = ValidateScope(scope);
        ValidateHex(executionId, 32);
        JournalRoot? root = null;
        ProtectedJournal? owner = null;
        SafeFileHandle? marker = null;
        bool transferred = false;
        try
        {
            root = JournalNativeMethods.PinRoot(recordsRoot);
            marker = JournalNativeMethods.CreateNew(root, key + ".reserved", out int error);
            if (marker is null)
            {
                if (error is 80 or 183) return Existing(ReadCore(root, scope, key, null, null));
                return Unknown(new("marker_create", error));
            }
            owner = new ProtectedJournal(root, scope, executionId, key, marker);
            root = null;
            marker = null;
            Observe("MarkerCreated", owner.marker, null);
            JournalNativeMethods.Flush(owner.marker);
            if (JournalNativeMethods.RequireFile(owner.marker, owner.root) != 0)
                throw new JournalFailure("marker_content");
            if (JournalNativeMethods.HasPriorHistory(owner.root, key)) throw new JournalFailure("reservation_history");
            JsonElement snapshot = owner.PublishEnvelope(null, null);
            transferred = true;
            return new(JournalStatus.Created, snapshot, owner, null);
        }
        catch (Exception error) when (IsEvidenceFailure(error)) { return Failure(error); }
        finally
        {
            marker?.Dispose();
            root?.Dispose();
            if (!transferred) owner?.Dispose();
        }
    }

    public static JournalResult InspectReservation(string recordsRoot, JournalScope expectedScope)
    {
        ValidateRootArgument(recordsRoot);
        string key = ValidateScope(expectedScope);
        try
        {
            using JournalRoot root = JournalNativeMethods.PinRoot(recordsRoot);
            return Existing(ReadCore(root, expectedScope, key, null, null));
        }
        catch (Exception error) when (IsEvidenceFailure(error)) { return Failure(error); }
    }

    public JournalResult Publish(string recordId, JsonElement record)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            ValidateHex(recordId, 32);
            JsonElement payload = ValidateRecord(record);
            bool previouslyAttempted = attempts.TryGetValue(recordId, out JournalDiagnostic? prior);
            try
            {
                JournalNativeMethods.RequireRoot(root);
                if (JournalNativeMethods.RequireFile(marker, root) != 0 || JournalNativeMethods.Identity(marker) != markerIdentity)
                    throw new JournalFailure("marker_identity");
                JsonElement? replay = ReadOwnRecord(recordId);
                if (replay is { } existing)
                {
                    if (JsonElement.DeepEquals(existing.GetProperty("record"), payload)) return Existing(existing);
                    return Unknown(new("record_replay_mismatch", null));
                }
                if (previouslyAttempted) return Unknown(prior!);
                // Mark before the first operation that could create evidence.
                // An uncertain temp never becomes a source for another call.
                attempts.Add(recordId, new("record_attempt_uncertain", null));
                JsonElement snapshot = PublishEnvelope(recordId, payload);
                return new(JournalStatus.Created, snapshot, null, null);
            }
            catch (Exception error) when (IsEvidenceFailure(error))
            {
                JournalResult failure = Failure(error);
                if (previouslyAttempted) return Unknown(prior!);
                if (attempts.ContainsKey(recordId)) attempts[recordId] = failure.Diagnostic!;
                // Only a verified exact final can turn a no-overwrite race
                // into an existing replay. No further mutation is attempted.
                if (failure.Diagnostic?.NativeError == 183)
                {
                    try
                    {
                        JsonElement? replay = ReadOwnRecord(recordId);
                        if (replay is { } existing && JsonElement.DeepEquals(existing.GetProperty("record"), payload))
                            return Existing(existing);
                    }
                    catch (Exception replayError) when (IsEvidenceFailure(replayError)) { }
                }
                return failure;
            }
        }
    }

    public static JournalResult Read(string recordsRoot, JournalScope expectedScope, string expectedExecutionId, string recordId)
    {
        ValidateRootArgument(recordsRoot);
        string key = ValidateScope(expectedScope);
        ValidateHex(expectedExecutionId, 32);
        ValidateHex(recordId, 32);
        try
        {
            using JournalRoot root = JournalNativeMethods.PinRoot(recordsRoot);
            return Existing(ReadCore(root, expectedScope, key, expectedExecutionId, recordId));
        }
        catch (Exception error) when (IsEvidenceFailure(error)) { return Failure(error); }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            for (int index = files.Count - 1; index >= 0; index--) files[index].Dispose();
            root.Dispose();
        }
    }

    private JsonElement PublishEnvelope(string? recordId, JsonElement? record)
    {
        string slot = recordId is null ? "reservation" : "record-" + recordId;
        string final = key + "." + slot + ".json";
        string temp = key + "." + slot + "." + Guid.NewGuid().ToString("N") + ".tmp";
        SafeFileHandle? source = JournalNativeMethods.CreateNew(root, temp, out int error);
        if (source is null) throw new JournalFailure("temp_create", error);
        files.Add(source);
        JournalFileIdentity fileIdentity = JournalNativeMethods.Identity(source);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            v = 1, kind = recordId is null ? "reservation" : "record", scope, executionId, recordId,
            rootIdentity = root.Identity, reservationIdentity = markerIdentity, fileIdentity, record,
        }, Json);
        SafeFileHandle? selectedReadOnly = null;
        try
        {
            SafeFileHandle selected = source;
#if ZEB_NATIVE_TESTS
            if (JournalTestControl.Fault == JournalTestFault.WriteReadOnly)
                selected = selectedReadOnly = JournalNativeMethods.OpenReadOnlySameObject(root, source);
#endif
            Observe("BeforeWrite", source, selected);
            JournalNativeMethods.Write(selected, bytes);
        }
        finally { selectedReadOnly?.Dispose(); }
        Observe(recordId is null ? "ReservationWritten" : "RecordWritten", source, null);
        selectedReadOnly = null;
        try
        {
            SafeFileHandle selected = source;
#if ZEB_NATIVE_TESTS
            if (JournalTestControl.Fault == JournalTestFault.FlushReadOnly)
                selected = selectedReadOnly = JournalNativeMethods.OpenReadOnlySameObject(root, source);
#endif
            Observe("BeforeFlush", source, selected);
            JournalNativeMethods.Flush(selected);
        }
        finally { selectedReadOnly?.Dispose(); }
        Observe(recordId is null ? "ReservationFlushed" : "RecordFlushed", source, null);
        JournalNativeMethods.Rename(root, source, final);
        Observe(recordId is null ? "ReservationRenamed" : "RecordRenamed", source, null);
        if (JournalNativeMethods.Identity(source) != fileIdentity) throw new JournalFailure("publication_identity");
        using SafeFileHandle reopened = JournalNativeMethods.OpenRead(root, final, true);
        if (JournalNativeMethods.Identity(reopened) != fileIdentity || !JournalNativeMethods.Read(reopened).SequenceEqual(bytes))
            throw new JournalFailure("publication_content");
        JsonElement snapshot = ReadEnvelope(reopened, root, markerIdentity, scope, executionId, recordId);
        Observe(recordId is null ? "ReservationVerified" : "RecordVerified", source, null);
        return snapshot;
    }

    private JsonElement? ReadOwnRecord(string recordId)
    {
        try
        {
            using SafeFileHandle file = JournalNativeMethods.OpenRead(root, key + ".record-" + recordId + ".json", true);
            return ReadEnvelope(file, root, markerIdentity, scope, executionId, recordId);
        }
        catch (JournalFailure error) when (error.Diagnostic.Stage == "file_open" && error.Diagnostic.NativeError is 2 or 3)
        {
            return null;
        }
    }

    private static JsonElement ReadCore(JournalRoot root, JournalScope scope, string key, string? executionId, string? recordId)
    {
        JournalNativeMethods.RequireRoot(root);
        using SafeFileHandle marker = JournalNativeMethods.OpenRead(root, key + ".reserved", false);
        if (JournalNativeMethods.RequireFile(marker, root) != 0) throw new JournalFailure("marker_content");
        JournalFileIdentity markerIdentity = JournalNativeMethods.Identity(marker);
        using SafeFileHandle reservation = JournalNativeMethods.OpenRead(root, key + ".reservation.json", false);
        JsonElement reserved = ReadEnvelope(reservation, root, markerIdentity, scope, executionId, null);
        if (recordId is null) return reserved;
        using SafeFileHandle file = JournalNativeMethods.OpenRead(root, key + ".record-" + recordId + ".json", false);
        return ReadEnvelope(file, root, markerIdentity, scope, executionId, recordId);
    }

    private static JsonElement ReadEnvelope(SafeFileHandle file, JournalRoot root, JournalFileIdentity markerIdentity,
        JournalScope expectedScope, string? expectedExecutionId, string? recordId)
    {
        try
        {
            byte[] bytes = JournalNativeMethods.Read(file);
            string text = Utf8.GetString(bytes);
            using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = int.MaxValue });
            JsonElement envelope = document.RootElement;
            ValidateTree(envelope);
            RequireKeys(envelope, "v", "kind", "scope", "executionId", "recordId", "rootIdentity", "reservationIdentity", "fileIdentity", "record");
            if (!envelope.GetProperty("v").TryGetInt32(out int version) || version != 1 ||
                Text(envelope, "kind") != (recordId is null ? "reservation" : "record"))
                throw new JournalFailure("envelope_invalid");
            string executionId = Text(envelope, "executionId");
            if (!IsHex(executionId, 32) || (expectedExecutionId is not null && executionId != expectedExecutionId))
                throw new JournalFailure("envelope_execution");
            RequireScope(envelope.GetProperty("scope"), expectedScope);
            if (ReadIdentity(envelope.GetProperty("rootIdentity")) != root.Identity ||
                ReadIdentity(envelope.GetProperty("reservationIdentity")) != markerIdentity ||
                ReadIdentity(envelope.GetProperty("fileIdentity")) != JournalNativeMethods.Identity(file))
                throw new JournalFailure("envelope_identity");
            if (recordId is null)
            {
                if (envelope.GetProperty("recordId").ValueKind != JsonValueKind.Null || envelope.GetProperty("record").ValueKind != JsonValueKind.Null)
                    throw new JournalFailure("envelope_invalid");
            }
            else if (Text(envelope, "recordId") != recordId || envelope.GetProperty("record").ValueKind != JsonValueKind.Object)
                throw new JournalFailure("envelope_invalid");
            return envelope.Clone();
        }
        catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException or KeyNotFoundException)
        {
            throw new JournalFailure("envelope_invalid");
        }
    }

    private static void RequireScope(JsonElement actual, JournalScope expected)
    {
        RequireKeys(actual, "target", "executionPolicyFingerprint");
        JsonElement target = actual.GetProperty("target");
        RequireKeys(target, "identity", "launchTicket");
        JsonElement identity = target.GetProperty("identity");
        RequireKeys(identity, "jobId", "attemptNo", "ownerInstanceId", "fence");
        JournalAttemptIdentity expectedIdentity = expected.Target.Identity;
        if (Text(identity, "jobId") != expectedIdentity.JobId || Text(identity, "ownerInstanceId") != expectedIdentity.OwnerInstanceId ||
            !identity.GetProperty("attemptNo").TryGetInt64(out long attempt) || attempt != expectedIdentity.AttemptNo ||
            !identity.GetProperty("fence").TryGetInt64(out long fence) || fence != expectedIdentity.Fence ||
            Text(target, "launchTicket") != expected.Target.LaunchTicket || Text(actual, "executionPolicyFingerprint") != expected.ExecutionPolicyFingerprint)
            throw new JournalFailure("envelope_scope");
    }

    private static JournalFileIdentity ReadIdentity(JsonElement actual)
    {
        RequireKeys(actual, "volumeSerial", "fileId");
        string volume = Text(actual, "volumeSerial");
        string fileId = Text(actual, "fileId");
        if (!ulong.TryParse(volume, NumberStyles.None, CultureInfo.InvariantCulture, out ulong serial) ||
            serial.ToString(CultureInfo.InvariantCulture) != volume || !IsHex(fileId, 32))
            throw new JournalFailure("envelope_identity");
        return new(volume, fileId);
    }

    private static string Text(JsonElement value, string property)
    {
        JsonElement item = value.GetProperty(property);
        if (item.ValueKind != JsonValueKind.String) throw new JournalFailure("envelope_invalid");
        return item.GetString() ?? throw new JournalFailure("envelope_invalid");
    }

    private static void RequireKeys(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new JournalFailure("envelope_invalid");
        var expected = new HashSet<string>(keys, StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
            if (!expected.Remove(property.Name)) throw new JournalFailure("envelope_invalid");
        if (expected.Count != 0) throw new JournalFailure("envelope_invalid");
    }

    private static JsonElement ValidateRecord(JsonElement record)
    {
        try
        {
            if (record.ValueKind != JsonValueKind.Object) throw InvalidArgument();
            ValidateTree(record);
            return record.Clone();
        }
        catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException or JournalFailure)
        {
            throw InvalidArgument();
        }
    }

    private static void ValidateTree(JsonElement value)
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
                    Utf8.GetByteCount(property.Name);
                    if (!names.Add(property.Name)) throw new JournalFailure("json_duplicate");
                    pending.Push(property.Value);
                }
            }
            else if (current.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement item in current.EnumerateArray()) pending.Push(item);
            }
            else if (current.ValueKind == JsonValueKind.String) Utf8.GetByteCount(current.GetString()!);
            else if (current.ValueKind == JsonValueKind.Undefined) throw new JournalFailure("json_invalid");
        }
    }

    private static void ValidateRootArgument(string root)
    {
        if (string.IsNullOrEmpty(root) || root.Contains('\0')) throw InvalidArgument();
    }

    private static string ValidateScope(JournalScope scope)
    {
        if (scope is null || scope.Target is null || scope.Target.Identity is null) throw InvalidArgument();
        JournalAttemptIdentity identity = scope.Target.Identity;
        ValidateIdentifier(identity.JobId);
        ValidateIdentifier(identity.OwnerInstanceId);
        ValidateIdentifier(scope.Target.LaunchTicket);
        if (identity.AttemptNo is <= 0 or > 9007199254740991 || identity.Fence is <= 0 or > 9007199254740991)
            throw InvalidArgument();
        ValidateHex(scope.ExecutionPolicyFingerprint, 64);
        return Convert.ToHexStringLower(SHA256.HashData(Utf8.GetBytes(scope.Target.LaunchTicket)));
    }

    private static void ValidateIdentifier(string value)
    {
        if (string.IsNullOrEmpty(value) || JsWhitespace(value[0]) || JsWhitespace(value[^1]) ||
            value.Any(character => character <= 0x1f || character == 0x7f)) throw InvalidArgument();
        try { Utf8.GetByteCount(value); }
        catch (EncoderFallbackException) { throw InvalidArgument(); }
    }

    private static bool JsWhitespace(char value) => value is >= '\u0009' and <= '\u000d' or '\u0020' or '\u00a0' or '\u1680' or
        >= '\u2000' and <= '\u200a' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff';

    private static bool IsHex(string? value, int length) => value is not null && value.Length == length &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void ValidateHex(string? value, int length)
    {
        if (!IsHex(value, length)) throw InvalidArgument();
    }

    private static ArgumentException InvalidArgument() => new("Invalid journal argument.");
    private static bool IsEvidenceFailure(Exception error) => error is JournalFailure or JsonException or IOException or UnauthorizedAccessException or
        Win32Exception or System.Security.SecurityException or ArgumentException or InvalidOperationException or NotSupportedException or OverflowException;
    private static JournalResult Existing(JsonElement snapshot) => new(JournalStatus.Existing, snapshot, null, null);
    private static JournalResult Unknown(JournalDiagnostic diagnostic) => new(JournalStatus.Unknown, null, null, diagnostic);
    private static JournalResult Failure(Exception error) => Unknown(error is JournalFailure failure ? failure.Diagnostic :
        error is Win32Exception native ? new("native_failure", native.NativeErrorCode) :
        new("journal_evidence", (unchecked((uint)error.HResult) & 0xffff0000u) == 0x80070000u ? error.HResult & 0xffff : null));

    private static void Observe(string stage, SafeFileHandle original, SafeFileHandle? selected)
    {
#if ZEB_NATIVE_TESTS
        JournalTestControl.Observer?.Invoke(Enum.Parse<JournalTestStage>(stage), original, selected);
#endif
    }
}

#if ZEB_NATIVE_TESTS
public enum JournalTestStage
{
    MarkerCreated, ReservationWritten, ReservationFlushed,
    ReservationRenamed, ReservationVerified, RecordWritten,
    RecordFlushed, RecordRenamed, RecordVerified, BeforeWrite, BeforeFlush
}
public enum JournalTestFault { None, WriteReadOnly, FlushReadOnly }
public static class JournalTestControl
{
    public static Action<JournalTestStage, SafeFileHandle?, SafeFileHandle?>? Observer { get; set; }
    public static JournalTestFault Fault { get; set; }
}
#endif
