using System.Text.Json;
using System.Text.Json.Serialization;

namespace Zeb.WindowsSupervisor;

// Diagnostic scalars explain a failed prepare; they never grant execution or cleanup authority.
public sealed record PrepareDiagnostic
{
    [JsonPropertyName("prepareStage")] public string PrepareStage { get; }
    [JsonPropertyName("nativeStage")] public string? NativeStage { get; }
    [JsonPropertyName("nativeErrorCode")] public int? NativeErrorCode { get; }

    private PrepareDiagnostic(string prepareStage, string? nativeStage, int? nativeErrorCode)
        => (PrepareStage, NativeStage, NativeErrorCode) = (prepareStage, nativeStage, nativeErrorCode);

    private static readonly HashSet<string> PrepareStages = new(StringComparer.Ordinal)
    {
        "arguments",
        "deadline",
        "descriptor",
        "installation_open",
        "job_inspect",
        "job_prepare",
        "job_streams",
        "prepared_publish",
        "request_publish",
        "request_record",
        "reservation",
        "runtime_observation",
    };
    private static readonly HashSet<string> NativeStages = new(StringComparer.Ordinal)
    {
        "CreateIoCompletionPort",
        "CreateJobObjectW",
        "CreatePipe",
        "CreateProcessW",
        "GetHandleInformation",
        "GetProcessId",
        "GetProcessTimes",
        "InitializeProcThreadAttributeList",
        "InitializeProcThreadAttributeList(size)",
        "IsProcessInJob",
        "QueryInformationJobObject",
        "SetHandleInformation",
        "SetInformationJobObject(completion-port)",
        "SetInformationJobObject(limits)",
        "UpdateProcThreadAttribute",
        "WaitForSingleObject",
        "ancestor_identity",
        "binary_binding",
        "current_user",
        "directory_open",
        "engine_payload",
        "envelope_execution",
        "envelope_identity",
        "envelope_invalid",
        "envelope_scope",
        "file_alias",
        "file_attributes",
        "file_flush",
        "file_identity",
        "file_open",
        "file_ordinary",
        "file_read_changed",
        "file_read_incomplete",
        "file_rename",
        "file_security",
        "file_standard",
        "file_type",
        "file_write",
        "file_write_incomplete",
        "final_path",
        "handle_noninheritance",
        "installation_manifest",
        "installation_root",
        "installation_verify",
        "io_identity",
        "journal_evidence",
        "json_array",
        "json_duplicate",
        "json_invalid",
        "json_keys",
        "json_object",
        "json_type",
        "manifest_entry",
        "manifest_file",
        "manifest_hash",
        "manifest_model",
        "manifest_recipe",
        "manifest_version",
        "marker_content",
        "marker_create",
        "marker_identity",
        "model_binding",
        "model_name",
        "model_pair",
        "model_payload",
        "model_set",
        "model_set_hash",
        "native_failure",
        "parent_identity",
        "path_invalid",
        "payload_hash",
        "payload_length",
        "payload_read",
        "publication_content",
        "publication_identity",
        "record_attempt_uncertain",
        "record_replay_mismatch",
        "rename_completion",
        "rename_layout",
        "rename_leaf",
        "rename_wait",
        "renamed_identity",
        "reservation_history",
        "root_identity",
        "root_path",
        "source_parent",
        "temp_create",
        "volume_information",
        "volume_mapping",
        "volume_not_fixed",
        "volume_ntfs_acl",
    };

    public static PrepareDiagnostic? Create(string prepareStage, string? nativeStage, int? nativeErrorCode)
        => PrepareStages.Contains(prepareStage) && (nativeStage is null || NativeStages.Contains(nativeStage))
            ? new(prepareStage, nativeStage, nativeErrorCode) : null;

    public static PrepareDiagnostic Parse(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var names = new HashSet<string>(["prepareStage", "nativeStage", "nativeErrorCode"], StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
            if (!names.Remove(property.Name)) throw new InvalidDataException();
        if (names.Count != 0) throw new InvalidDataException();
        JsonElement stage = value.GetProperty("prepareStage"), native = value.GetProperty("nativeStage"),
            error = value.GetProperty("nativeErrorCode");
        if (stage.ValueKind != JsonValueKind.String || native.ValueKind is not (JsonValueKind.String or JsonValueKind.Null))
            throw new InvalidDataException();
        int? nativeErrorCode = null;
        if (error.ValueKind != JsonValueKind.Null)
        {
            if (error.ValueKind != JsonValueKind.Number || !error.TryGetInt32(out int code)) throw new InvalidDataException();
            nativeErrorCode = code;
        }
        return Create(stage.GetString()!, native.ValueKind == JsonValueKind.Null ? null : native.GetString(), nativeErrorCode)
            ?? throw new InvalidDataException();
    }
}
