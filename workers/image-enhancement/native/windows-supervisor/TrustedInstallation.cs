using System.Buffers;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsSupervisor;

public sealed record EngineSelection(string ModelId, string BinaryVersion, string BinarySha256,
    string ModelVersion, string ModelSha256, long NativeScale, long Tile, bool Tta, long GpuId);

public sealed record ResolvedEngineLaunch(string RecipeId, string InstallationManifestSha256,
    string ExecutablePath, string ModelDirectory, string ModelName);

public sealed record InstallationDiagnostic(string Stage, int? NativeError);

public sealed class InstallationException : Exception
{
    public InstallationDiagnostic Diagnostic { get; }

    public InstallationException(string stage, int? nativeError = null) : base("installation_invalid")
        => Diagnostic = new(stage, nativeError);
}

[SupportedOSPlatform("windows")]
public sealed class TrustedInstallation : IDisposable
{
    private const string Recipe = "upscayl-4x-png-v1";
    private const long MaxSafeInteger = 9007199254740991;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly object gate = new();
    private readonly EngineSelection engine;
    private readonly List<IDisposable> pins;
    private bool disposed;

    private TrustedInstallation(EngineSelection engine, ResolvedEngineLaunch launch, List<IDisposable> pins)
    {
        this.engine = engine;
        this.pins = pins;
        Launch = launch;
    }

    public static TrustedInstallation Open(string installationRoot, string expectedManifestSha256,
        EngineSelection engine)
    {
        string originalRoot = ValidateRootArgument(installationRoot);
        ValidateSelection(engine);
        if (!IsSha256(expectedManifestSha256)) throw InvalidArgument();
        EngineSelection frozen = engine with { };
        var pins = new List<IDisposable>();
        bool transfer = false;
        string stage = "installation_root";
        try
        {
            JournalRoot root = JournalNativeMethods.PinRoot(originalRoot);
            pins.Add(root);
            var evidence = new InstallationEvidence(originalRoot, root, pins);
            stage = "installation_manifest";
            PinnedFile manifestFile = evidence.OpenFile("installation-manifest.json");
            using JsonDocument manifestJson = ReadDocument(manifestFile, expectedManifestSha256, "manifest_hash");
            Manifest manifest = ReadManifest(manifestJson.RootElement);
            FileDeclaration? entry = manifest.Files.FirstOrDefault(file => file.Path == manifest.EntryPoint);
            if (entry is null || manifest.BinaryVersion != frozen.BinaryVersion || entry.Sha256 != frozen.BinarySha256)
                throw new InstallationException("binary_binding");
            ModelDeclaration? selected = manifest.Models.FirstOrDefault(model => model.Id == frozen.ModelId);
            if (selected is null || selected.Version != frozen.ModelVersion || selected.Sha256 != frozen.ModelSha256)
                throw new InstallationException("model_binding");

            stage = "engine_payload";
            PinnedFile? executable = null;
            foreach (FileDeclaration declared in manifest.Files)
            {
                PinnedFile file = evidence.OpenFile(declared.Path);
                VerifyPayload(file, declared);
                if (declared.Path == manifest.EntryPoint) executable = file;
            }
            stage = "model_set";
            JournalRoot modelDirectory = evidence.Parent(selected.Directory);
            PinnedFile modelSetFile = evidence.OpenFile(selected.Directory + "/model-set.json");
            using JsonDocument modelSetJson = ReadDocument(modelSetFile, selected.Sha256, "model_set_hash");
            FileDeclaration[] pair = ReadModelSet(modelSetJson.RootElement, selected.Name);
            stage = "model_payload";
            foreach (FileDeclaration declared in pair)
                VerifyPayload(evidence.OpenFile(selected.Directory + "/" + declared.Path), declared);

            stage = "installation_verify";
            if (executable is null) throw new InstallationException("binary_binding");
            string executablePath = @"\\?\" + System.IO.Path.Combine(originalRoot, manifest.EntryPoint.Replace('/', '\\'));
            pins.Add(JournalNativeMethods.OpenReadBoundAlias(executable.Parent, executable.Handle, executablePath));
            evidence.Revalidate();
            // Upscayl rejects extended model paths; pins still protect the same DOS alias.
            var launch = new ResolvedEngineLaunch(Recipe, expectedManifestSha256, executablePath,
                System.IO.Path.Combine(originalRoot, selected.Directory.Replace('/', '\\')), selected.Name);
            var result = new TrustedInstallation(frozen, launch, pins);
            transfer = true;
            return result;
        }
        catch (InstallationException) { throw; }
        catch (JournalFailure error)
        {
            throw new InstallationException(error.Diagnostic.Stage, error.Diagnostic.NativeError);
        }
        catch (Exception error) when (IsEvidenceFailure(error))
        {
            throw new InstallationException(stage, NativeError(error));
        }
        finally
        {
            if (!transfer) Release(pins);
        }
    }

    public ResolvedEngineLaunch Launch { get; }

    public IReadOnlyList<string> CreateArguments(string inputPath, string outputPath)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!IsLocalPath(inputPath) || !IsLocalPath(outputPath)) throw InvalidArgument();
            var arguments = new List<string>
            {
                "-i", inputPath, "-o", outputPath, "-m", Launch.ModelDirectory, "-n", Launch.ModelName,
                "-z", "4", "-t", engine.Tile.ToString(CultureInfo.InvariantCulture), "-f", "png",
                "-g", engine.GpuId.ToString(CultureInfo.InvariantCulture),
            };
            if (engine.Tta) arguments.Add("-x");
            return arguments.AsReadOnly();
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            Release(pins);
        }
    }

    private sealed record FileDeclaration(string Path, long Length, string Sha256);
    private sealed record ModelDeclaration(string Id, string Version, string Directory, string Name, string Sha256);
    private sealed record Manifest(string BinaryVersion, string EntryPoint, FileDeclaration[] Files, ModelDeclaration[] Models);
    private sealed record PinnedFile(SafeFileHandle Handle, JournalRoot Parent, string Path, JournalFileIdentity Identity, long Length);

    private sealed class InstallationEvidence
    {
        private readonly string originalRoot;
        private readonly JournalRoot root;
        private readonly List<IDisposable> pins;
        private readonly Dictionary<string, JournalRoot> parents = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<JournalFileIdentity> directoryIds = new();
        private readonly HashSet<JournalFileIdentity> fileIds = new();
        private readonly HashSet<string> paths = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<PinnedFile> files = new();

        internal InstallationEvidence(string originalRoot, JournalRoot root, List<IDisposable> pins)
        {
            this.originalRoot = originalRoot;
            this.root = root;
            this.pins = pins;
            parents.Add("", root);
            directoryIds.Add(root.Identity);
        }

        internal JournalRoot Parent(string relative)
        {
            if (parents.TryGetValue(relative, out JournalRoot? existing)) return existing;
            RequireRelativePath(relative);
            string prefix = "";
            JournalRoot previous = root;
            foreach (string component in relative.Split('/'))
            {
                prefix = prefix.Length == 0 ? component : prefix + "/" + component;
                if (!parents.TryGetValue(prefix, out JournalRoot? parent))
                {
                    parent = JournalNativeMethods.PinRoot(System.IO.Path.Combine(originalRoot, prefix.Replace('/', '\\')));
                    pins.Add(parent);
                    if (!root.User.Equals(parent.User) || parent.Identity.VolumeSerial != root.Identity.VolumeSerial ||
                        !SamePath(parent.Path, root.Path + "\\" + prefix.Replace('/', '\\')) ||
                        !SamePath(System.IO.Path.GetDirectoryName(parent.Path), previous.Path) || !directoryIds.Add(parent.Identity))
                        throw new InstallationException("parent_identity");
                    parents.Add(prefix, parent);
                }
                previous = parent;
            }
            return previous;
        }

        internal PinnedFile OpenFile(string relative)
        {
            RequireRelativePath(relative);
            if (!paths.Add(relative)) throw new InstallationException("file_alias");
            int separator = relative.LastIndexOf('/');
            JournalRoot parent = Parent(separator < 0 ? "" : relative[..separator]);
            string leaf = relative[(separator + 1)..];
            SafeFileHandle handle = JournalNativeMethods.OpenRead(parent, leaf, false);
            pins.Add(handle);
            var file = new PinnedFile(handle, parent, parent.Path + "\\" + leaf,
                JournalNativeMethods.Identity(handle), JournalNativeMethods.RequireFile(handle, parent));
            if (!fileIds.Add(file.Identity)) throw new InstallationException("file_alias");
            RequireSnapshot(file);
            files.Add(file);
            return file;
        }

        internal void Revalidate()
        {
            foreach (JournalRoot parent in parents.Values) JournalNativeMethods.RequireRoot(parent);
            foreach (PinnedFile file in files) RequireSnapshot(file);
        }
    }

    private static void RequireSnapshot(PinnedFile file)
    {
        if (JournalNativeMethods.RequireFile(file.Handle, file.Parent) != file.Length ||
            JournalNativeMethods.Identity(file.Handle) != file.Identity ||
            !SamePath(JournalNativeMethods.FinalPath(file.Handle), file.Path))
            throw new InstallationException("file_identity");
    }

    private static void VerifyPayload(PinnedFile file, FileDeclaration declared)
    {
        if (file.Length != declared.Length) throw new InstallationException("payload_length");
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = ArrayPool<byte>.Shared.Rent(81920);
        try
        {
            long offset = 0;
            while (offset < file.Length)
            {
                int count = RandomAccess.Read(file.Handle, buffer.AsSpan(0, (int)Math.Min(buffer.Length, file.Length - offset)), offset);
                if (count == 0) throw new InstallationException("payload_read");
                hash.AppendData(buffer, 0, count);
                offset += count;
            }
            RequireSnapshot(file);
            if (Convert.ToHexStringLower(hash.GetHashAndReset()) != declared.Sha256)
                throw new InstallationException("payload_hash");
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    private static JsonDocument ReadDocument(PinnedFile file, string expectedSha256, string hashStage)
    {
        byte[] bytes = JournalNativeMethods.Read(file.Handle);
        RequireSnapshot(file);
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != expectedSha256) throw new InstallationException(hashStage);
        return JsonDocument.Parse(Utf8.GetString(bytes), new JsonDocumentOptions
        {
            MaxDepth = int.MaxValue, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false,
        });
    }

    private static Manifest ReadManifest(JsonElement value)
    {
        RequireKeys(value, "v", "platform", "recipeId", "binaryVersion", "entryPoint", "files", "models");
        RequireVersionOne(value);
        if (Text(value, "platform") != "win-x64" || Text(value, "recipeId") != Recipe)
            throw new InstallationException("manifest_recipe");
        string version = Text(value, "binaryVersion"), entry = Text(value, "entryPoint");
        if (!IsVersion(version)) throw new InstallationException("manifest_version");
        RequireRelativePath(entry);
        FileDeclaration[] files = ReadFiles(value.GetProperty("files"));
        if (!files.Any(file => file.Path == entry)) throw new InstallationException("manifest_entry");
        JsonElement catalog = RequireArray(value.GetProperty("models"));
        var models = new List<ModelDeclaration>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (JsonElement item in catalog.EnumerateArray())
        {
            RequireKeys(item, "modelId", "modelVersion", "modelDirectory", "modelName", "modelSetSha256");
            string id = Text(item, "modelId"), modelVersion = Text(item, "modelVersion");
            string directory = Text(item, "modelDirectory"), name = Text(item, "modelName"), sha = Text(item, "modelSetSha256");
            RequireRelativePath(directory);
            if (!IsModelId(id) || !ids.Add(id) || !IsVersion(modelVersion) || !directories.Add(directory) ||
                !IsComponent(name, true) || !IsSha256(sha)) throw new InstallationException("manifest_model");
            models.Add(new(id, modelVersion, directory, name, sha));
        }
        return new(version, entry, files, models.ToArray());
    }

    private static FileDeclaration[] ReadModelSet(JsonElement value, string name)
    {
        RequireKeys(value, "v", "modelName", "files");
        RequireVersionOne(value);
        if (Text(value, "modelName") != name) throw new InstallationException("model_name");
        FileDeclaration[] files = ReadFiles(value.GetProperty("files"));
        if (files.Length != 2 || !files.Any(file => file.Path == name + ".bin") || !files.Any(file => file.Path == name + ".param"))
            throw new InstallationException("model_pair");
        return files;
    }

    private static FileDeclaration[] ReadFiles(JsonElement value)
    {
        var files = new List<FileDeclaration>();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (JsonElement item in RequireArray(value).EnumerateArray())
        {
            RequireKeys(item, "path", "length", "sha256");
            string path = Text(item, "path"), length = Text(item, "length"), sha = Text(item, "sha256");
            RequireRelativePath(path);
            if (!paths.Add(path) || !IsSha256(sha) ||
                !long.TryParse(length, NumberStyles.None, CultureInfo.InvariantCulture, out long count) || count < 0 ||
                count.ToString(CultureInfo.InvariantCulture) != length) throw new InstallationException("manifest_file");
            files.Add(new(path, count, sha));
        }
        return files.ToArray();
    }

    private static void RequireKeys(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InstallationException("json_object");
        var expected = new HashSet<string>(keys, StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            Utf8.GetByteCount(property.Name);
            if (!expected.Remove(property.Name)) throw new InstallationException("json_keys");
        }
        if (expected.Count != 0) throw new InstallationException("json_keys");
    }

    private static string Text(JsonElement value, string key)
    {
        JsonElement item = value.GetProperty(key);
        if (item.ValueKind != JsonValueKind.String) throw new InstallationException("json_type");
        string text = item.GetString() ?? throw new InstallationException("json_type");
        Utf8.GetByteCount(text);
        return text;
    }

    private static JsonElement RequireArray(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() == 0) throw new InstallationException("json_array");
        return value;
    }

    private static void RequireVersionOne(JsonElement value)
    {
        JsonElement version = value.GetProperty("v");
        if (version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out int number) || number != 1)
            throw new InstallationException("manifest_version");
    }

    private static void ValidateSelection(EngineSelection engine)
    {
        if (engine is null || !IsModelId(engine.ModelId) || !IsVersion(engine.BinaryVersion) || !IsVersion(engine.ModelVersion) ||
            !IsSha256(engine.BinarySha256) || !IsSha256(engine.ModelSha256) || engine.NativeScale != 4 ||
            engine.Tile < 0 || engine.Tile > MaxSafeInteger || (engine.Tile != 0 && engine.Tile < 32) ||
            engine.GpuId < 0 || engine.GpuId > MaxSafeInteger) throw InvalidArgument();
    }

    private static string ValidateRootArgument(string value)
    {
        if (!IsLocalPath(value)) throw InvalidArgument();
        string path = value.Replace('/', '\\');
        string relative = path[3..];
        if (relative.Length != 0)
        {
            if (relative.EndsWith('\\')) relative = relative[..^1];
            if (relative.Length == 0 || !relative.Split('\\').All(component => IsComponent(component, false))) throw InvalidArgument();
        }
        try { return System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(path)); }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or IOException) { throw InvalidArgument(); }
    }

    private static bool IsLocalPath(string? value) => value is { Length: >= 3 } && char.IsAsciiLetter(value[0]) &&
        value[1] == ':' && (value[2] is '\\' or '/') && !value.Contains('\0') && ValidUtf8(value) && System.IO.Path.IsPathFullyQualified(value);

    private static void RequireRelativePath(string value)
    {
        if (value.Length == 0 || !value.Split('/').All(component => IsComponent(component, false)))
            throw new InstallationException("path_invalid");
    }

    private static bool IsComponent(string value, bool stem)
    {
        if (value.Length == 0 || value is "." or ".." || value.EndsWith(' ') || value.EndsWith('.') ||
            value.Any(character => character <= 0x1f || character is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*') ||
            (stem && (JsWhitespace(value[0]) || JsWhitespace(value[^1]))) || !ValidUtf8(value)) return false;
        int dot = value.IndexOf('.');
        string basename = (dot < 0 ? value : value[..dot]).TrimEnd(' ');
        if (new[] { "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$" }
            .Contains(basename, StringComparer.OrdinalIgnoreCase)) return false;
        return !(basename.Length == 4 && (basename.StartsWith("COM", StringComparison.OrdinalIgnoreCase) ||
            basename.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && (basename[3] is >= '1' and <= '9' or '\u00b9' or '\u00b2' or '\u00b3'));
    }

    private static bool IsModelId(string? value) => !string.IsNullOrEmpty(value) && char.IsAsciiLetterOrDigit(value[0]) &&
        value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-');

    private static bool IsVersion(string? value) => !string.IsNullOrEmpty(value) && !JsWhitespace(value[0]) && !JsWhitespace(value[^1]) &&
        !value.Any(character => character <= 0x1f || character == 0x7f) && ValidUtf8(value);

    private static bool IsSha256(string? value) => value is { Length: 64 } &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool JsWhitespace(char value) => value is >= '\u0009' and <= '\u000d' or '\u0020' or '\u00a0' or '\u1680' or
        >= '\u2000' and <= '\u200a' or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff';

    private static bool ValidUtf8(string value)
    {
        try { Utf8.GetByteCount(value); return true; }
        catch (EncoderFallbackException) { return false; }
    }

    private static bool SamePath(string? left, string? right) => left is not null && right is not null &&
        string.Equals(left.TrimEnd('\\'), right.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    private static ArgumentException InvalidArgument() => new("Invalid installation argument.");
    private static bool IsEvidenceFailure(Exception error) => error is JsonException or IOException or UnauthorizedAccessException or
        Win32Exception or System.Security.SecurityException or CryptographicException or ArgumentException or InvalidOperationException or NotSupportedException or OverflowException or KeyNotFoundException;
    private static int? NativeError(Exception error) => error is Win32Exception native ? native.NativeErrorCode :
        (unchecked((uint)error.HResult) & 0xffff0000u) == 0x80070000u ? error.HResult & 0xffff : null;

    private static void Release(List<IDisposable> pins)
    {
        for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
        pins.Clear();
    }
}
