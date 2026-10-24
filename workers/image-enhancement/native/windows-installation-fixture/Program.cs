using System.ComponentModel;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

[SupportedOSPlatform("windows")]
internal static class Program
{
    internal static readonly UTF8Encoding Utf8 = new(false, true);
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    internal const long UnsafeInteger = 9007199254740992;

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Utf8;
        Console.InputEncoding = Utf8;
        var receipt = new Receipt(args.Length > 1 ? args[1] : "invalid");
        Context? context = null;
        try
        {
            Require(OperatingSystem.IsWindows() && Environment.Is64BitProcess && args.Length == 3, "fixture_arguments");
            context = new Context(args[0]);
            receipt.Setup = new
            {
                ordinary = Ordinary(args[2]),
                utf8 = new { webName = Utf8.WebName, codePage = Utf8.CodePage, encoderFallback = Utf8.EncoderFallback.GetType().Name, decoderFallback = Utf8.DecoderFallback.GetType().Name, preambleBytes = Utf8.GetPreamble().Length },
                utf8Echo = "installation 測試 🙂 with spaces"
            };
            context.SetupComplete = true;
            receipt.Values = receipt.Scenario switch
            {
                "T0" => Positive(context),
                "T1" => ValidInstallation(context),
                "T2" => ManifestRejections(context),
                "T3" => BindingRejections(context),
                "T4" => UnsafeEvidence(context),
                "T5" => LeaseLifetime(context),
                "T6" => CatalogSelection(context),
                "T7" => PartialFailure(context),
                "D07MP" => SelectedModelProductReadDenied(context),
                _ => throw new InvalidDataException("fixture_scenario")
            };
        }
        catch (Exception error)
        {
            if (context?.SetupComplete == true) receipt.Failure = Failure(error);
            else receipt.SetupFailure = Failure(error);
        }
        finally
        {
            receipt.Cleanup = context?.Cleanup() ?? new { failures = Array.Empty<object>(), activePins = Array.Empty<object>(), allLeasesReleased = true };
        }
        Console.WriteLine(JsonSerializer.Serialize(new { kind = "installation-receipt", value = receipt }, Json));
        return 0;
    }

    private static object Ordinary(string approvedPath)
    {
        var assembly = typeof(TrustedInstallation).Assembly;
        var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
        var hooks = assembly.GetTypes().SelectMany(type => type.GetMembers(flags).Select(member => type.Name + "." + member.Name))
            .Where(name => name.Contains("TestHook", StringComparison.OrdinalIgnoreCase) || name.Contains("ForTest", StringComparison.OrdinalIgnoreCase)).ToArray();
        using var loaded = Probe.Open(assembly.Location);
        using var approved = Probe.Open(approvedPath);
        var loadedHash = Probe.Hash(loaded);
        var approvedHash = Probe.Hash(approved);
        Require(loadedHash == approvedHash && hooks.Length == 0, "ordinary_assembly_identity_or_hooks");
        return new { approvedBytesMatch = true, testHooksAbsent = true, loadedSha256 = loadedHash, approvedSha256 = approvedHash, moduleVersionId = assembly.ManifestModule.ModuleVersionId.ToString("D") };
    }

    private static object SelectedModelProductReadDenied(Context context)
    {
        var bundle = context.Bundle();
        var selectedOutcome = Open(context, bundle, out var installation);
        Require(installation is not null && selectedOutcome.Opened, "model_product_selected_open");
        ResolvedEngineLaunch launch = installation!.Launch;
        string selected = Path.Combine(launch.ModelDirectory, launch.ModelName + ".bin");
        Require(string.Equals(selected, bundle.ModelBinPath, StringComparison.OrdinalIgnoreCase), "model_product_selected_binding");
        EngineSelection frozen = bundle.Engine with { };
        string expectedManifest = bundle.ExpectedManifest;
        context.Release(installation!);
        Require(Probe.ActivePins(bundle.Paths).Length == 0, "model_product_selected_release");

        string control = Path.Combine(launch.ModelDirectory, "d07mp-readable-control.bin");
        Probe.CreateFile(control, Utf8.GetBytes("public inert D07MP control\n"));
        byte[] callerBytes = File.ReadAllBytes(selected);
        var leafBefore = Probe.Inspect(selected);
        var controlBefore = Probe.Inspect(control);
        var before = bundle.Snapshot();
        const AccessControlSections sections = AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access;
        FileSecurity originalAcl = new FileInfo(selected).GetAccessControl();
        byte[] originalDescriptor = originalAcl.GetSecurityDescriptorBinaryForm();
        string originalSddl = originalAcl.GetSecurityDescriptorSddlForm(sections);
        var ancestorAcls = new List<(string Path, string Sddl)>();
        for (DirectoryInfo? directory = new FileInfo(selected).Directory; directory is not null; directory = directory.Parent)
            ancestorAcls.Add((directory.FullName, directory.GetAccessControl().GetSecurityDescriptorSddlForm(sections)));
        using (var prior = WindowsIdentity.GetCurrent(ifImpersonating: true))
            Require(prior is null, "model_product_plain_caller");
        using var caller = WindowsIdentity.GetCurrent();
        SecurityIdentifier sid = caller.User ?? throw new InvalidDataException("model_product_caller_sid");
        Probe.DataReadAttempt? controlRead = null;
        Probe.DataReadAttempt? selectedRead = null;
        Outcome? deniedOutcome = null;
        object[] activeOtherPinsAfterDeniedOpen = [];
        bool denyReadDataInstalled = false;
        bool ancestorAclsUnchangedDuring = false;
        var failures = new List<Exception>();
        try
        {
            var deniedAcl = new FileSecurity();
            deniedAcl.SetSecurityDescriptorBinaryForm(originalDescriptor, AccessControlSections.Access);
            deniedAcl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.ReadData, AccessControlType.Deny));
            new FileInfo(selected).SetAccessControl(deniedAcl);
            denyReadDataInstalled = new FileInfo(selected).GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier))
                .Cast<FileSystemAccessRule>().Any(rule => rule.IdentityReference.Equals(sid) && !rule.IsInherited &&
                    rule.AccessControlType == AccessControlType.Deny && rule.FileSystemRights == FileSystemRights.ReadData &&
                    rule.InheritanceFlags == InheritanceFlags.None && rule.PropagationFlags == PropagationFlags.None);
            controlRead = Probe.ReadDataByte(control);
            selectedRead = Probe.ReadDataByte(selected);
            deniedOutcome = Open(context, bundle, out var rejected);
            if (rejected is not null) context.Release(rejected);
            activeOtherPinsAfterDeniedOpen = Probe.ActivePins(bundle.Paths.Append(control)
                .Where(path => !string.Equals(path, selected, StringComparison.OrdinalIgnoreCase)));
            ancestorAclsUnchangedDuring = ancestorAcls.All(saved =>
                new DirectoryInfo(saved.Path).GetAccessControl().GetSecurityDescriptorSddlForm(sections) == saved.Sddl);
        }
        catch (Exception error) { failures.Add(error); }
        finally
        {
            try { Probe.RestoreDacl(selected, originalDescriptor); }
            catch (Exception error) { failures.Add(error); }
        }
        if (failures.Count != 0) throw new AggregateException("model_product_probe_or_restore_failed", failures);
        Require(deniedOutcome is not null && controlRead is not null && selectedRead is not null, "model_product_evidence_missing");
        bool callerBytesPreserved = callerBytes.SequenceEqual(bundle.ModelBinBytes) && File.ReadAllBytes(selected).SequenceEqual(callerBytes);
        bool leafAclRestored = new FileInfo(selected).GetAccessControl().GetSecurityDescriptorSddlForm(sections) == originalSddl;
        bool leafPreserved = Equal(leafBefore, Probe.Inspect(selected));
        bool controlPreserved = Equal(controlBefore, Probe.Inspect(control));
        bool ancestorAclsUnchangedAfter = ancestorAcls.All(saved =>
            new DirectoryInfo(saved.Path).GetAccessControl().GetSecurityDescriptorSddlForm(sections) == saved.Sddl);
        bool bundlePreserved = Equal(before, bundle.Snapshot()) && bundle.HashesMatch();
        var reopenedOutcome = Open(context, bundle, out var reopened);
        Require(reopened is not null && reopenedOutcome.Opened, "model_product_reopen");
        bool bindingPreserved;
        try { bindingPreserved = bundle.Engine == frozen && bundle.ExpectedManifest == expectedManifest && reopened!.Launch == launch; }
        finally { context.Release(reopened!); }
        return new
        {
            selectedOutcome, deniedOutcome, reopenedOutcome,
            selectedFromProductionLaunch = true, denyReadDataInstalled,
            controlRead, selectedRead, activeOtherPinsAfterDeniedOpen,
            callerBytesPreserved, leafAclRestored, leafPreserved, controlPreserved,
            ancestorAclsUnchangedDuring, ancestorAclsUnchangedAfter, bundlePreserved, bindingPreserved,
            activePinsAfterProbe = Probe.ActivePins(bundle.Paths.Append(control)),
            productReadDenialExercised = deniedOutcome is { Opened: false, Diagnostic: { Stage: "file_open", NativeError: 5 } },
            workflowDiagnosticExercised = false, scmIdentityExercised = false
        };
    }

    private static object Positive(Context context)
    {
        var bundle = context.Bundle();
        var mutableBefore = Probe.Mutable(bundle.Paths);
        Require(mutableBefore.All(Probe.IsMutable), "independent_positive_mutability");
        var before = bundle.Snapshot();
        var held = new List<SafeFileHandle>();
        object pins;
        object denied;
        object volume;
        try
        {
            foreach (var path in bundle.Paths) held.Add(Probe.Open(path, strict: true));
            volume = Probe.Volume(bundle.Root, held[0]);
            foreach (var handle in held) Probe.RequireProtected(handle);
            pins = Probe.Pins(bundle.Paths);
            denied = Probe.Denied(bundle.Paths);
            Require(Probe.AllDenied(denied), "independent_positive_sharing");
        }
        finally { for (var index = held.Count - 1; index >= 0; index--) held[index].Dispose(); }
        var unchanged = Equal(before, bundle.Snapshot());
        var files = Probe.Files(bundle.Paths);
        var malformedRejected = false;
        try { Utf8.GetString([0xff]); } catch (DecoderFallbackException) { malformedRejected = true; }
        Require(unchanged && malformedRejected, "independent_positive_preservation_or_utf8");
        using var manifest = JsonDocument.Parse(Utf8.GetString(File.ReadAllBytes(bundle.ManifestPath)));
        using var modelSet = JsonDocument.Parse(Utf8.GetString(File.ReadAllBytes(bundle.ModelSetPath)));
        return new { productionOpenCalls = 0, files, volume, binding = Probe.BundleBinding(bundle.Paths), pins, denied, released = Probe.Mutable(bundle.Paths), hashesMatch = bundle.HashesMatch(), strictJsonUtf8 = true, bytesAndTimesUnchanged = unchanged, decoderRejectsMalformed = malformedRejected };
    }

    private static object ValidInstallation(Context context)
    {
        var bundle = context.Bundle();
        var before = bundle.Snapshot();
        var outcome = Open(context, bundle, out var installation);
        if (installation is null) return new { outcome };
        var launch = installation.Launch;
        var arguments = installation.CreateArguments(bundle.Input, bundle.Output);
        var expected = ExpectedArguments(bundle, launch);
        var readOnly = ArgumentsReadOnly(arguments);
        var argumentRejections = InvalidLaunchArguments(installation, bundle);
        var pins = Probe.Pins(bundle.Paths);
        var denied = Probe.Denied(bundle.Paths);
        var pathsBound = Probe.SameObject(launch.ExecutablePath, bundle.BinaryPath) && Probe.SameObject(launch.ModelDirectory, bundle.ModelDirectory);
        var unchanged = Equal(before, bundle.Snapshot());
        return new { outcome, launch, arguments, expectedArguments = expected, recipeMatches = launch.RecipeId == "upscayl-4x-png-v1" && launch.InstallationManifestSha256 == bundle.ExpectedManifest && launch.ModelName == Bundle.ModelName && arguments.SequenceEqual(expected), argumentsReadOnly = readOnly, argumentRejections, launchPathsBound = pathsBound, hashesMatch = bundle.HashesMatch(), bytesAndTimesUnchanged = unchanged, binding = Probe.BundleBinding(bundle.Paths), pins, denied, files = Probe.Files(bundle.Paths) };
    }

    private static object ManifestRejections(Context context)
    {
        var cases = new List<object>();
        void Add(string name, Action<Bundle> mutate) => cases.Add(Reject(context, name, mutate));
        Add("external-digest", b => b.ExpectedManifest = Different(b.ExpectedManifest));
        Add("manifest-utf8", b => b.ManifestBytes([0xff, 0xfe, 0x7b]));
        Add("manifest-json", b => b.ManifestBytes(Utf8.GetBytes("{invalid}")));
        Add("manifest-trailing", b => b.ManifestBytes(Utf8.GetBytes(b.ManifestText + " {}")));
        Add("manifest-partial", b => b.ManifestBytes(Utf8.GetBytes("{\"v\":")));
        Add("manifest-array", b => b.ManifestBytes(Utf8.GetBytes("[]")));
        Add("root-duplicate", b => b.ManifestBytes(Utf8.GetBytes(b.ManifestText.Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal))));
        Add("root-unknown", b => b.EditManifest(node => node["extra"] = true));
        Add("root-missing", b => b.EditManifest(node => node.Remove("recipeId")));
        Add("root-type", b => b.EditManifest(node => node["v"] = "1"));
        Add("manifest-version", b => b.EditManifest(node => node["v"] = 2));
        Add("manifest-platform", b => b.EditManifest(node => node["platform"] = "other-platform"));
        Add("manifest-recipe", b => b.EditManifest(node => node["recipeId"] = "other-recipe"));
        Add("files-empty", b => b.EditManifest(node => node["files"] = new JsonArray()));
        Add("entry-undeclared", b => b.EditManifest(node => node["entryPoint"] = "bin/missing.exe"));
        Add("file-duplicate", b => b.ManifestBytes(Utf8.GetBytes(b.ManifestText.Replace("\"path\":\"bin/upscayl-bin.exe\"", "\"path\":\"bin/upscayl-bin.exe\",\"path\":\"bin/upscayl-bin.exe\"", StringComparison.Ordinal))));
        Add("file-unknown", b => b.EditManifest(node => node["files"]![0]!["extra"] = true));
        Add("file-missing", b => b.EditManifest(node => node["files"]![0]!.AsObject().Remove("sha256")));
        Add("file-type", b => b.EditManifest(node => node["files"]![0]!["length"] = 123));
        Add("file-case-collision", b => b.EditManifest(node => node["files"]!.AsArray().Add(new JsonObject { ["path"] = "BIN/UPSCAYL-BIN.EXE", ["length"] = b.BinaryBytes.Length.ToString(CultureInfo.InvariantCulture), ["sha256"] = Hash(b.BinaryBytes) })));
        Add("length-noncanonical", b => b.EditManifest(node => node["files"]![0]!["length"] = "0" + b.BinaryBytes.Length.ToString(CultureInfo.InvariantCulture)));
        Add("digest-uppercase", b => b.EditManifest(node => node["files"]![0]!["sha256"] = new string('A', 64)));
        Add("model-duplicate", b => b.ManifestBytes(Utf8.GetBytes(b.ManifestText.Replace("\"modelId\":\"fixture-model\"", "\"modelId\":\"fixture-model\",\"modelId\":\"fixture-model\"", StringComparison.Ordinal))));
        Add("model-unknown", b => b.EditManifest(node => node["models"]![0]!["extra"] = true));
        Add("model-missing", b => b.EditManifest(node => node["models"]![0]!.AsObject().Remove("modelVersion")));
        Add("model-type", b => b.EditManifest(node => node["models"]![0]!["modelId"] = 1));
        Add("catalog-digest-uppercase", b => b.EditManifest(node => node["models"]![0]!["modelSetSha256"] = new string('A', 64)));
        Add("catalog-id-duplicate", b => b.EditManifest(node => { var second = node["models"]![0]!.DeepClone(); second["modelDirectory"] = "models/second-model"; node["models"]!.AsArray().Add(second); }));
        Add("catalog-path-collision", b => b.EditManifest(node => { var second = node["models"]![0]!.DeepClone(); second["modelId"] = "second-model"; second["modelDirectory"] = "MODELS/FIXTURE-MODEL"; node["models"]!.AsArray().Add(second); }));
        return new { cases };
    }

    private static object BindingRejections(Context context)
    {
        var cases = new List<object>();
        void Add(string name, Action<Bundle> mutate, bool argument = false) => cases.Add(Reject(context, name, mutate, argument));
        Add("binary-version", b => b.Engine = b.Engine with { BinaryVersion = "other-version" });
        Add("binary-digest", b => b.Engine = b.Engine with { BinarySha256 = Different(b.Engine.BinarySha256) });
        Add("model-version", b => b.Engine = b.Engine with { ModelVersion = "other-version" });
        Add("model-digest", b => b.Engine = b.Engine with { ModelSha256 = Different(b.Engine.ModelSha256) });
        Add("model-id", b => b.Engine = b.Engine with { ModelId = "missing-model" });
        Add("native-scale", b => b.Engine = b.Engine with { NativeScale = 2 }, true);
        Add("tta", b => b.Engine = b.Engine with { Tta = true }, true);
        Add("tile-small", b => b.Engine = b.Engine with { Tile = 31 }, true);
        Add("tile-unsafe", b => b.Engine = b.Engine with { Tile = UnsafeInteger }, true);
        Add("gpu-negative", b => b.Engine = b.Engine with { GpuId = -1 }, true);
        Add("gpu-unsafe", b => b.Engine = b.Engine with { GpuId = UnsafeInteger }, true);
        foreach (var kind in new[] { "binary", "dependency", "model-set", "model-bin", "model-param" })
        {
            Add(kind + "-changed", b => b.ChangePayload(kind, "changed"));
            Add(kind + "-missing", b => b.ChangePayload(kind, "missing"));
            Add(kind + "-truncated", b => b.ChangePayload(kind, "truncated"));
        }
        Add("model-name", b => b.EditModelSet(node => node["modelName"] = "other-model"));
        Add("model-pair-name", b => b.EditModelSet(node => node["files"]![0]!["path"] = "wrong.bin"));
        Add("model-pair-duplicate", b => b.EditModelSet(node => node["files"]![1] = node["files"]![0]!.DeepClone()));
        Add("model-pair-missing", b => b.EditModelSet(node => node["files"]!.AsArray().RemoveAt(1)));
        Add("model-set-unknown", b => b.EditModelSet(node => node["extra"] = true));
        Add("model-set-duplicate", b => b.ModelSetBytes(Utf8.GetBytes(b.ModelSetText.Replace("\"v\":1", "\"v\":1,\"v\":1", StringComparison.Ordinal)), approve: true));
        Add("model-file-unknown", b => b.EditModelSet(node => node["files"]![0]!["extra"] = true));
        Add("model-file-duplicate", b => b.ModelSetBytes(Utf8.GetBytes(b.ModelSetText.Replace("\"path\":\"upscayl-standard-4x.bin\"", "\"path\":\"upscayl-standard-4x.bin\",\"path\":\"upscayl-standard-4x.bin\"", StringComparison.Ordinal)), approve: true));
        Add("model-file-length", b => b.EditModelSet(node => node["files"]![0]!["length"] = "01"));
        Add("model-set-utf8", b => b.ModelSetBytes([0xff], approve: true));
        Add("model-set-json", b => b.ModelSetBytes(Utf8.GetBytes("{invalid}"), approve: true));
        Add("model-set-trailing", b => b.ModelSetBytes(Utf8.GetBytes(b.ModelSetText + " {}"), approve: true));
        Add("model-set-array", b => b.ModelSetBytes(Utf8.GetBytes("[]"), approve: true));
        Add("model-set-type", b => b.EditModelSet(node => node["v"] = "1"));
        Add("model-set-missing-field", b => b.EditModelSet(node => node.Remove("modelName")));
        Add("model-file-missing-field", b => b.EditModelSet(node => node["files"]![0]!.AsObject().Remove("sha256")));
        Add("model-file-type", b => b.EditModelSet(node => node["files"]![0]!["length"] = 1));
        Add("model-file-digest", b => b.EditModelSet(node => node["files"]![0]!["sha256"] = new string('A', 64)));
        return new { cases };
    }

    private static object UnsafeEvidence(Context context)
    {
        var cases = new List<object>();
        void Add(string name, Action<Bundle> mutate, Func<Bundle, object>? proof = null) => cases.Add(Reject(context, name, mutate, proof: proof));
        Add("root-extra-ace", b => Probe.AddExtraAce(b.Root), b => Probe.Inspect(b.Root));
        Add("binary-parent-extra-ace", b => Probe.AddExtraAce(b.BinDirectory), b => Probe.Inspect(b.BinDirectory));
        Add("models-chain-extra-ace", b => Probe.AddExtraAce(b.ModelsDirectory), b => Probe.Inspect(b.ModelsDirectory));
        Add("model-parent-extra-ace", b => Probe.AddExtraAce(b.ModelDirectory), b => Probe.Inspect(b.ModelDirectory));
        Add("file-extra-ace", b => Probe.AddExtraAce(b.BinaryPath), b => Probe.Inspect(b.BinaryPath));
        Add("manifest-extra-ace", b => Probe.AddExtraAce(b.ManifestPath), b => Probe.Inspect(b.ManifestPath));
        Add("dependency-extra-ace", b => Probe.AddExtraAce(b.DependencyPath), b => Probe.Inspect(b.DependencyPath));
        Add("model-set-extra-ace", b => Probe.AddExtraAce(b.ModelSetPath), b => Probe.Inspect(b.ModelSetPath));
        Add("model-bin-extra-ace", b => Probe.AddExtraAce(b.ModelBinPath), b => Probe.Inspect(b.ModelBinPath));
        Add("model-param-extra-ace", b => Probe.AddExtraAce(b.ParamPath), b => Probe.Inspect(b.ParamPath));
        Add("file-directory", b => { File.Delete(b.BinaryPath); Probe.CreateDirectory(b.BinaryPath); }, b => Probe.Inspect(b.BinaryPath));
        Add("file-hardlink", b => Probe.Check(Probe.CreateHardLinkW(b.BinaryPath + ".link", b.BinaryPath, IntPtr.Zero), "independent_create_hardlink"), b => Probe.Inspect(b.BinaryPath));
        Add("root-junction", b => b.Junction(b.Root), b => Probe.Inspect(b.Root));
        Add("parent-junction", b => b.Junction(b.ModelsDirectory), b => Probe.Inspect(b.ModelsDirectory));
        foreach (var (name, path) in new[]
        {
            ("path-dotdot", "bin/../bin/upscayl-bin.exe"),
            ("path-dot", "bin/./upscayl-bin.exe"), ("path-empty", "bin//upscayl-bin.exe"),
            ("path-backslash", @"bin\upscayl-bin.exe"), ("path-ads", "bin/upscayl-bin.exe:alternate"),
            ("path-device", "bin/NUL"), ("path-device-extension", "bin/CON.exe"),
            ("path-absolute", @"C:/fixture/upscayl-bin.exe"), ("path-unc", "//fixture/share/upscayl-bin.exe"),
            ("path-trailing-dot", "bin/upscayl-bin.exe."), ("path-trailing-space", "bin/upscayl-bin.exe "),
            ("path-invalid-character", "bin/upscayl?bin.exe")
        }) Add(name, b => b.EditManifest(node => { node["files"]![0]!["path"] = path; node["entryPoint"] = path; }));
        Add("model-stem-separator", b => { b.EditModelSet(node => node["modelName"] = "bad/stem"); b.EditManifest(node => node["models"]![0]!["modelName"] = "bad/stem"); });
        Add("model-stem-whitespace", b => { b.EditModelSet(node => node["modelName"] = "\ufeff" + Bundle.ModelName); b.EditManifest(node => node["models"]![0]!["modelName"] = "\ufeff" + Bundle.ModelName); });
        return new { cases };
    }

    private static object LeaseLifetime(Context context)
    {
        var bundle = context.Bundle();
        var before = bundle.Snapshot();
        var outcome = Open(context, bundle, out var installation);
        if (installation is null) return new { outcome };
        var pins = Probe.Pins(bundle.Paths);
        var denied = Probe.Denied(bundle.Paths);
        var unchanged = Equal(before, bundle.Snapshot());
        context.Release(installation);
        installation.Dispose();
        var rejected = false;
        try { installation.CreateArguments(bundle.Input, bundle.Output); } catch (ObjectDisposedException) { rejected = true; }
        var active = Probe.ActivePins(bundle.Paths);
        var released = Probe.Mutable(bundle.Paths);
        var oldHash = Hash(File.ReadAllBytes(bundle.BinaryPath));
        File.WriteAllBytes(bundle.BinaryPath, [.. bundle.BinaryBytes, 0x58]);
        var newHash = Hash(File.ReadAllBytes(bundle.BinaryPath));
        return new { outcome, pins, denied, bytesAndTimesUnchanged = unchanged, disposeTwiceSucceeded = true, disposedArgumentsRejected = rejected, afterDisposeWriteSucceeded = true, afterDisposeHashChanged = oldHash != newHash, activePinsAfterDispose = active, released };
    }

    private static object CatalogSelection(Context context)
    {
        var positives = new List<object>();
        foreach (var ordered in new[] { false, true })
        {
            var bundle = context.Bundle();
            bundle.AddUnselected();
            if (ordered) { bundle.ReorderRawJson(); bundle.Engine = bundle.Engine with { Tile = 0, GpuId = UnsafeInteger - 1 }; }
            var before = bundle.Snapshot();
            var frozenEngine = bundle.Engine;
            var expectedManifest = bundle.ExpectedManifest;
            var outcome = Open(context, bundle, out var installation);
            if (installation is null) { positives.Add(new { name = ordered ? "raw-json-order" : "catalog-selected", outcome }); continue; }
            var launch = installation.Launch;
            var arguments = installation.CreateArguments(bundle.Input, bundle.Output);
            var expected = ExpectedArguments(bundle, launch);
            var pins = Probe.Pins(bundle.Paths);
            bundle.Engine = bundle.Engine with { ModelId = "second-model", Tile = 0, GpuId = 1 };
            var callerCatalog = JsonNode.Parse(bundle.ManifestText)!.AsObject();
            callerCatalog["models"]![0]!["modelId"] = "caller-changed";
            callerCatalog["models"]!.AsArray().Clear();
            var callerArray = arguments.ToArray();
            callerArray[0] = "caller-changed";
            var frozen = ArgumentsReadOnly(arguments) && arguments.SequenceEqual(expected) && installation.CreateArguments(bundle.Input, bundle.Output).SequenceEqual(expected) && installation.Launch == launch;
            positives.Add(new { name = ordered ? "raw-json-order" : "catalog-selected", outcome, pins, unselectedBytesAbsent = !Directory.Exists(Path.Combine(bundle.Root, "models", "second-model")), snapshotFrozen = frozen, rawManifestHashMatches = launch.InstallationManifestSha256 == expectedManifest && expectedManifest == Hash(File.ReadAllBytes(bundle.ManifestPath)), rawModelHashMatches = frozenEngine.ModelSha256 == Hash(File.ReadAllBytes(bundle.ModelSetPath)), bytesAndTimesUnchanged = Equal(before, bundle.Snapshot()) });
            context.Release(installation);
        }
        {
            const string name = "path-case-spelling";
            var bundle = context.Bundle();
            bundle.AddUnselected();
            bundle.EditManifest(node => { node["files"]![0]!["path"] = "BIN/upscayl-bin.exe"; node["entryPoint"] = "BIN/upscayl-bin.exe"; });
            var before = bundle.Snapshot();
            var frozenEngine = bundle.Engine;
            var expectedManifest = bundle.ExpectedManifest;
            var outcome = Open(context, bundle, out var installation);
            if (installation is null) positives.Add(new { name, outcome });
            else
            {
                var launch = installation.Launch;
                var arguments = installation.CreateArguments(bundle.Input, bundle.Output);
                var expected = ExpectedArguments(bundle, launch);
                var readOnly = ArgumentsReadOnly(arguments);
                var pins = Probe.Pins(bundle.Paths);
                var denied = Probe.Denied(bundle.Paths);
                var files = Probe.Files(bundle.Paths);
                var binding = Probe.BundleBinding(bundle.Paths);
                var pathsBound = Probe.SameObject(launch.ExecutablePath, bundle.BinaryPath) && Probe.SameObject(launch.ModelDirectory, bundle.ModelDirectory);
                bundle.Engine = bundle.Engine with { ModelId = "second-model", Tile = 0, GpuId = 1 };
                var callerCatalog = JsonNode.Parse(bundle.ManifestText)!.AsObject();
                var declaredEntryPoint = callerCatalog["entryPoint"]!.GetValue<string>();
                var declaredBinaryPath = callerCatalog["files"]![0]!["path"]!.GetValue<string>();
                var declaredFiles = callerCatalog["files"]!.AsArray().Count;
                callerCatalog["models"]![0]!["modelId"] = "caller-changed";
                callerCatalog["models"]!.AsArray().Clear();
                var callerArray = arguments.ToArray();
                callerArray[0] = "caller-changed";
                var frozen = readOnly && arguments.SequenceEqual(expected) && installation.CreateArguments(bundle.Input, bundle.Output).SequenceEqual(expected) && installation.Launch == launch;
                var rawManifestHashMatches = launch.InstallationManifestSha256 == expectedManifest && expectedManifest == Hash(File.ReadAllBytes(bundle.ManifestPath));
                var rawModelHashMatches = frozenEngine.ModelSha256 == Hash(File.ReadAllBytes(bundle.ModelSetPath));
                var payloadHashesMatch = bundle.ExpectedHashes.Where(entry => entry.Key != bundle.ManifestPath && entry.Key != bundle.ModelSetPath).All(entry => Hash(File.ReadAllBytes(entry.Key)) == entry.Value);
                var unchanged = Equal(before, bundle.Snapshot());
                context.Release(installation);
                positives.Add(new { name, outcome, pins, denied, files, binding, declaredEntryPoint, declaredBinaryPath, declaredFiles, arguments, expectedArguments = expected, argumentsReadOnly = readOnly, launchPathsBound = pathsBound, unselectedBytesAbsent = !Directory.Exists(Path.Combine(bundle.Root, "models", "second-model")), snapshotFrozen = frozen, rawManifestHashMatches, rawModelHashMatches, payloadHashesMatch, bytesAndTimesUnchanged = unchanged, activePinsAfterDispose = Probe.ActivePins(bundle.Paths), released = Probe.Mutable(bundle.Paths) });
            }
        }
        var cases = new[]
        {
            Reject(context, "unselected-requested", b => { b.AddUnselected(); b.Engine = b.Engine with { ModelId = "second-model" }; }),
            Reject(context, "unknown-requested", b => { b.AddUnselected(); b.Engine = b.Engine with { ModelId = "unknown-model" }; }),
            Reject(context, "catalog-selected-version", b => { b.AddUnselected(); b.EditManifest(node => node["models"]![0]!["modelVersion"] = "other-version"); }),
            Reject(context, "catalog-selected-digest", b => { b.AddUnselected(); b.EditManifest(node => node["models"]![0]!["modelSetSha256"] = Different(b.Engine.ModelSha256)); })
        };
        return new { positives, cases };
    }

    private static object PartialFailure(Context context)
    {
        var late = Reject(context, "late-selected-param-hash", b => b.ChangePayload("model-param", "changed"), proof: b => new { earlierPayloadHashesMatch = b.EarlierHashesMatch(), latePairHashMismatch = Hash(File.ReadAllBytes(b.ParamPath)) != b.ExpectedHashes[b.ParamPath], latePairLengthMatches = Probe.Inspect(b.ParamPath).Length == b.ParamBytes.LongLength.ToString(CultureInfo.InvariantCulture) });
        var lateNode = JsonSerializer.SerializeToNode(late, Json)!.AsObject();
        lateNode["earlierPayloadHashesMatch"] = lateNode["proof"]!["earlierPayloadHashesMatch"]!.DeepClone();
        lateNode["latePairHashMismatch"] = lateNode["proof"]!["latePairHashMismatch"]!.DeepClone();
        lateNode["latePairLengthMatches"] = lateNode["proof"]!["latePairLengthMatches"]!.DeepClone();
        lateNode["neverReturnedLease"] = !lateNode["outcome"]!["opened"]!.GetValue<bool>();
        var arguments = InvalidArguments(context);
        var corrected = context.Bundle();
        corrected.ChangePayload("model-param", "changed");
        var bad = Open(context, corrected, out var badLease);
        if (badLease is not null) context.Release(badLease);
        File.WriteAllBytes(corrected.ParamPath, corrected.ParamBytes);
        var good = Open(context, corrected, out var goodLease);
        if (goodLease is not null) context.Release(goodLease);
        return new { cases = new[] { lateNode }, arguments, correctedFirstFailure = bad, correctedIndependentOpen = good, correctionWasOwnWrite = Hash(File.ReadAllBytes(corrected.ParamPath)) == Hash(corrected.ParamBytes), correctedBundleReleased = Probe.ActivePins(corrected.Paths).Length == 0 && Probe.Mutable(corrected.Paths).All(Probe.IsMutable) };
    }

    private static object[] InvalidArguments(Context context)
    {
        var reference = context.Bundle();
        var variants = new List<(string Name, Func<string, string?> Root, string? Manifest, EngineSelection? Engine)>();
        void Root(string name, string? value) => variants.Add((name, _ => value, reference.ExpectedManifest, reference.Engine));
        void Manifest(string name, string? value) => variants.Add((name, path => path, value, reference.Engine));
        void Engine(string name, EngineSelection? engine) => variants.Add((name, path => path, reference.ExpectedManifest, engine));
        Root("root-null", null); Root("root-empty", ""); Root("root-relative", "relative"); Root("root-nul", "C:\\fixture\0invalid");
        Root("root-unc", @"\\fixture\share\installation"); Root("root-device", @"\\.\fixture");
        Manifest("manifest-null", null); Manifest("manifest-empty", ""); Manifest("manifest-uppercase", new string('A', 64)); Manifest("manifest-nonhex", new string('x', 64));
        Engine("engine-null", null); Engine("id-empty", reference.Engine with { ModelId = "" }); Engine("id-invalid", reference.Engine with { ModelId = "bad/id" });
        Engine("version-empty", reference.Engine with { BinaryVersion = "" }); Engine("version-whitespace", reference.Engine with { BinaryVersion = "\ufeffversion" }); Engine("version-control", reference.Engine with { BinaryVersion = "v\u007f1" });
        Engine("model-version-empty", reference.Engine with { ModelVersion = "" }); Engine("binary-hash-invalid", reference.Engine with { BinarySha256 = "invalid" }); Engine("model-hash-invalid", reference.Engine with { ModelSha256 = "invalid" });
        Engine("scale-invalid", reference.Engine with { NativeScale = 3 }); Engine("tta-invalid", reference.Engine with { Tta = true }); Engine("tile-negative", reference.Engine with { Tile = -1 }); Engine("tile-invalid", reference.Engine with { Tile = 1 });
        Engine("tile-unsafe", reference.Engine with { Tile = UnsafeInteger }); Engine("gpu-negative", reference.Engine with { GpuId = -1 }); Engine("gpu-unsafe", reference.Engine with { GpuId = UnsafeInteger });
        return variants.Select((variant, index) =>
        {
            var absent = Path.Combine(context.Directory, "absent-api-" + index.ToString(CultureInfo.InvariantCulture));
            var before = System.IO.Directory.EnumerateFileSystemEntries(context.Directory).Order(StringComparer.Ordinal).ToArray();
            var rootAbsentBefore = !System.IO.Directory.Exists(absent) && !File.Exists(absent);
            var outcome = OpenRaw(context, variant.Root(absent)!, variant.Manifest!, variant.Engine!, out var lease);
            if (lease is not null) context.Release(lease);
            return (object)new { name = variant.Name, rootAbsentBefore, rootAbsentAfter = !System.IO.Directory.Exists(absent) && !File.Exists(absent), treeUnchanged = before.SequenceEqual(System.IO.Directory.EnumerateFileSystemEntries(context.Directory).Order(StringComparer.Ordinal)), outcome };
        }).ToArray();
    }

    private static object Reject(Context context, string name, Action<Bundle> mutate, bool argument = false, Func<Bundle, object>? proof = null)
    {
        var bundle = context.Bundle();
        var original = bundle.Snapshot();
        var engine = bundle.Engine;
        var approved = bundle.ExpectedManifest;
        mutate(bundle);
        var before = bundle.Snapshot();
        var mutationProven = !Equal(original, before) || engine != bundle.Engine || approved != bundle.ExpectedManifest;
        Require(mutationProven, "independent_mutation_not_reached");
        var boundary = proof?.Invoke(bundle) ?? new { expectedManifestSha256 = bundle.ExpectedManifest, actualManifestSha256 = Hash(File.ReadAllBytes(bundle.ManifestPath)), engineChanged = engine != bundle.Engine, filesChanged = !Equal(original, before) };
        var outcome = Open(context, bundle, out var installation);
        if (installation is not null) context.Release(installation);
        return new { name, argument, mutationProven, proof = boundary, outcome, unchanged = Equal(before, bundle.Snapshot()), activePins = Probe.ActivePins(bundle.Paths), mutable = Probe.Mutable(bundle.OrdinaryPaths) };
    }

    private static Outcome Open(Context context, Bundle bundle, out TrustedInstallation? installation) => OpenRaw(context, bundle.Root, bundle.ExpectedManifest, bundle.Engine, out installation);
    private static Outcome OpenRaw(Context context, string root, string expected, EngineSelection engine, out TrustedInstallation? installation)
    {
        installation = null;
        try
        {
            installation = TrustedInstallation.Open(root, expected, engine);
            context.Leases.Add(installation);
            return new(true, null, null, null);
        }
        catch (InstallationException error) { return new(false, nameof(InstallationException), error.Message, error.Diagnostic); }
        catch (ArgumentException error) { return new(false, error.GetType().Name, "argument_invalid", null); }
    }

    private static string[] ExpectedArguments(Bundle bundle, ResolvedEngineLaunch launch) => ["-i", bundle.Input, "-o", bundle.Output, "-m", launch.ModelDirectory, "-n", launch.ModelName, "-z", "4", "-t", bundle.Engine.Tile.ToString(CultureInfo.InvariantCulture), "-f", "png", "-g", bundle.Engine.GpuId.ToString(CultureInfo.InvariantCulture)];
    private static bool ArgumentsReadOnly(IReadOnlyList<string> arguments)
    {
        if (arguments is not IList<string> list || !list.IsReadOnly) return false;
        var setRejected = false;
        var addRejected = false;
        try { list[0] = "caller-changed"; } catch (NotSupportedException) { setRejected = true; }
        try { list.Add("caller-added"); } catch (NotSupportedException) { addRejected = true; }
        return setRejected && addRejected;
    }
    private static object[] InvalidLaunchArguments(TrustedInstallation installation, Bundle bundle)
    {
        var values = new (string Name, string? Value)[] { ("null", null), ("empty", ""), ("relative", "relative.png"), ("drive-relative", "C:relative.png"), ("nul", "C:\\fixture\0image.png"), ("unc", @"\\fixture\share\image.png"), ("device", @"\\.\fixture") };
        return values.SelectMany(value => new[] { false, true }.Select(output =>
        {
            var rejected = false;
            try { installation.CreateArguments(output ? bundle.Input : value.Value!, output ? value.Value! : bundle.Output); }
            catch (ArgumentException error) { rejected = error.GetType() == typeof(ArgumentException); }
            return (object)new { name = (output ? "output-" : "input-") + value.Name, rejected };
        })).ToArray();
    }
    internal static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static string Different(string hash) => (hash[0] == '0' ? "1" : "0") + hash[1..];
    internal static bool Equal(object left, object right) => JsonElement.DeepEquals(JsonSerializer.SerializeToElement(left, Json), JsonSerializer.SerializeToElement(right, Json));
    internal static void Require(bool condition, string stage) { if (!condition) throw new InvalidDataException(stage); }
    private static object Failure(Exception error) => new { type = error.GetType().Name, stage = error.Data["fixtureStage"] as string ?? (error is InvalidDataException && error.Message.All(character => char.IsAsciiLetterOrDigit(character) || character == '_') ? error.Message : "fixture_failure"), nativeError = error is Win32Exception native ? (int?)native.NativeErrorCode : null, snapshot = error.Data["fixtureSnapshot"] };

    private sealed record Outcome(bool Opened, string? ExceptionType, string? Message, InstallationDiagnostic? Diagnostic);
    private sealed class Receipt(string scenario)
    {
        public string Scenario { get; } = scenario;
        public object? SetupFailure { get; set; }
        public object? Failure { get; set; }
        public object Setup { get; set; } = new { };
        public object Values { get; set; } = new { };
        public object Cleanup { get; set; } = new { };
        public string[] ConditionalUnexecuted { get; } = ["independent-wrong-SID", "remote-filesystem", "non-NTFS-volume", "other-volume"];
    }

    private sealed class Context
    {
        internal string Directory { get; }
        internal bool SetupComplete { get; set; }
        internal List<TrustedInstallation> Leases { get; } = [];
        private readonly List<Bundle> bundles = [];
        internal Context(string directory)
        {
            Require(Path.IsPathFullyQualified(directory) && System.IO.Directory.Exists(directory) && !System.IO.Directory.EnumerateFileSystemEntries(directory).Any(), "fixture_exact_empty_directory");
            Directory = Path.GetFullPath(directory);
            using var handle = Probe.Open(Directory);
            _ = Probe.Volume(Directory, handle);
        }
        internal Bundle Bundle() { var bundle = new Bundle(Path.Combine(Directory, "installation 測試 " + bundles.Count.ToString(CultureInfo.InvariantCulture))); bundles.Add(bundle); return bundle; }
        internal void Release(TrustedInstallation installation) { installation.Dispose(); Leases.Remove(installation); }
        internal object Cleanup()
        {
            var failures = new List<object>();
            for (var index = Leases.Count - 1; index >= 0; index--)
            {
                try { Leases[index].Dispose(); Leases.RemoveAt(index); } catch (Exception error) { failures.Add(Program.Failure(error)); }
            }
            object[] pins = [];
            try { pins = Probe.ActivePins(bundles.SelectMany(bundle => bundle.Paths).Distinct(StringComparer.OrdinalIgnoreCase)); }
            catch (Exception error) { failures.Add(Program.Failure(error)); }
            return new { failures, activePins = pins, allLeasesReleased = Leases.Count == 0 && failures.Count == 0 && pins.Length == 0 };
        }
    }

    private sealed class Bundle
    {
        internal const string ModelName = "upscayl-standard-4x";
        internal string Root { get; }
        internal string BinDirectory => Path.Combine(Root, "bin");
        internal string ModelsDirectory => Path.Combine(Root, "models");
        internal string ModelDirectory => Path.Combine(ModelsDirectory, "fixture-model");
        internal string ManifestPath => Path.Combine(Root, "installation-manifest.json");
        internal string BinaryPath => Path.Combine(BinDirectory, "upscayl-bin.exe");
        internal string DependencyPath => Path.Combine(BinDirectory, "runtime.dll");
        internal string ModelSetPath => Path.Combine(ModelDirectory, "model-set.json");
        internal string ModelBinPath => Path.Combine(ModelDirectory, ModelName + ".bin");
        internal string ParamPath => Path.Combine(ModelDirectory, ModelName + ".param");
        internal string Input => Path.Combine(Path.GetDirectoryName(Root)!, "input 商品 🙂 with spaces.png");
        internal string Output => Path.Combine(Path.GetDirectoryName(Root)!, "output 商品 🙂 with spaces.png");
        internal byte[] BinaryBytes { get; } = Utf8.GetBytes("inert declared executable payload\n");
        internal byte[] DependencyBytes { get; } = Utf8.GetBytes("inert declared dependency payload\n");
        internal byte[] ModelBinBytes { get; } = [0x00, 0x17, 0xff, 0x08, 0x7f];
        internal byte[] ParamBytes { get; } = Utf8.GetBytes("7767517\nfixture parameter bytes\n");
        internal EngineSelection Engine { get; set; }
        internal string ExpectedManifest { get; set; }
        internal Dictionary<string, string> ExpectedHashes { get; } = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<string> extraRoots = [];
        internal string[] Paths => [Root, BinDirectory, ModelsDirectory, ModelDirectory, ManifestPath, BinaryPath, DependencyPath, ModelSetPath, ModelBinPath, ParamPath, .. extraRoots];
        internal IEnumerable<string> OrdinaryPaths => Paths.Where(path => File.Exists(path) || System.IO.Directory.Exists(path)).Where(path => (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0);
        internal string ManifestText => Utf8.GetString(File.ReadAllBytes(ManifestPath));
        internal string ModelSetText => Utf8.GetString(File.ReadAllBytes(ModelSetPath));

        internal Bundle(string root)
        {
            Root = root;
            foreach (var directory in new[] { Root, BinDirectory, ModelsDirectory, ModelDirectory }) Probe.CreateDirectory(directory);
            Probe.CreateFile(BinaryPath, BinaryBytes); Probe.CreateFile(DependencyPath, DependencyBytes);
            Probe.CreateFile(ModelBinPath, ModelBinBytes); Probe.CreateFile(ParamPath, ParamBytes);
            var modelSet = new JsonObject { ["v"] = 1, ["modelName"] = ModelName, ["files"] = new JsonArray(Entry(ModelName + ".bin", ModelBinBytes), Entry(ModelName + ".param", ParamBytes)) };
            var modelBytes = Utf8.GetBytes(modelSet.ToJsonString(Json));
            Probe.CreateFile(ModelSetPath, modelBytes);
            Engine = new("fixture-model", "fixture-cli-v1", Hash(BinaryBytes), "fixture-model-v1", Hash(modelBytes), 4, 256, false, 0);
            var manifest = new JsonObject
            {
                ["v"] = 1, ["platform"] = "win-x64", ["recipeId"] = "upscayl-4x-png-v1", ["binaryVersion"] = Engine.BinaryVersion,
                ["entryPoint"] = "bin/upscayl-bin.exe", ["files"] = new JsonArray(Entry("bin/upscayl-bin.exe", BinaryBytes), Entry("bin/runtime.dll", DependencyBytes)),
                ["models"] = new JsonArray(new JsonObject { ["modelId"] = Engine.ModelId, ["modelVersion"] = Engine.ModelVersion, ["modelDirectory"] = "models/fixture-model", ["modelName"] = ModelName, ["modelSetSha256"] = Engine.ModelSha256 })
            };
            var bytes = Utf8.GetBytes(manifest.ToJsonString(Json));
            Probe.CreateFile(ManifestPath, bytes);
            ExpectedManifest = Hash(bytes);
            foreach (var path in Paths.Where(File.Exists)) ExpectedHashes.Add(path, Hash(File.ReadAllBytes(path)));
            foreach (var path in Paths) { using var handle = Probe.Open(path); Probe.RequireProtected(handle); }
            Require(HashesMatch(), "independent_bundle_hashes");
        }

        private static JsonObject Entry(string path, byte[] bytes) => new() { ["path"] = path, ["length"] = bytes.LongLength.ToString(CultureInfo.InvariantCulture), ["sha256"] = Hash(bytes) };
        internal object Snapshot() => new[] { Root }.Concat(extraRoots).Distinct(StringComparer.OrdinalIgnoreCase).SelectMany(Probe.Tree).OrderBy(entry => entry.Path, StringComparer.Ordinal).ToArray();
        internal bool HashesMatch() => ExpectedHashes.All(entry => File.Exists(entry.Key) && Hash(File.ReadAllBytes(entry.Key)) == entry.Value);
        internal bool EarlierHashesMatch() => ExpectedHashes.Where(entry => entry.Key != ParamPath).All(entry => File.Exists(entry.Key) && Hash(File.ReadAllBytes(entry.Key)) == entry.Value);
        internal void ManifestBytes(byte[] bytes) { File.WriteAllBytes(ManifestPath, bytes); ExpectedManifest = Hash(File.ReadAllBytes(ManifestPath)); }
        internal void EditManifest(Action<JsonObject> edit) { var node = JsonNode.Parse(ManifestText)!.AsObject(); edit(node); ManifestBytes(Utf8.GetBytes(node.ToJsonString(Json))); }
        internal void EditModelSet(Action<JsonObject> edit) { var node = JsonNode.Parse(ModelSetText)!.AsObject(); edit(node); ModelSetBytes(Utf8.GetBytes(node.ToJsonString(Json)), approve: true); }
        internal void ModelSetBytes(byte[] bytes, bool approve)
        {
            File.WriteAllBytes(ModelSetPath, bytes);
            if (!approve) return;
            var digest = Hash(File.ReadAllBytes(ModelSetPath));
            Engine = Engine with { ModelSha256 = digest };
            EditManifest(node => node["models"]![0]!["modelSetSha256"] = digest);
        }
        internal void ChangePayload(string kind, string change)
        {
            var path = kind switch { "binary" => BinaryPath, "dependency" => DependencyPath, "model-set" => ModelSetPath, "model-bin" => ModelBinPath, "model-param" => ParamPath, _ => throw new InvalidDataException("fixture_payload_kind") };
            var original = File.ReadAllBytes(path);
            if (change == "missing") File.Delete(path);
            else
            {
                if (change == "changed") { original[0] ^= 1; File.WriteAllBytes(path, original); }
                else File.WriteAllBytes(path, original[..^1]);
            }
        }
        internal void AddUnselected() => EditManifest(node => node["models"]!.AsArray().Add(new JsonObject { ["modelId"] = "second-model", ["modelVersion"] = Engine.ModelVersion, ["modelDirectory"] = "models/second-model", ["modelName"] = ModelName, ["modelSetSha256"] = Engine.ModelSha256 }));
        internal void ReorderRawJson()
        {
            var modelSet = JsonNode.Parse(ModelSetText)!.AsObject();
            var pair = modelSet["files"]!.AsArray();
            var first = pair[0]!.DeepClone(); pair[0] = pair[1]!.DeepClone(); pair[1] = first;
            ModelSetBytes(Utf8.GetBytes(" \n" + Reverse(modelSet).ToJsonString(Json) + "\n "), approve: true);
            ManifestBytes(Utf8.GetBytes("\n " + Reverse(JsonNode.Parse(ManifestText)!.AsObject()).ToJsonString(Json) + " \n"));
        }
        private static JsonObject Reverse(JsonObject node) { var reversed = new JsonObject(); foreach (var field in node.Reverse()) reversed.Add(field.Key, field.Value?.DeepClone()); return reversed; }
        internal void Junction(string path)
        {
            var target = path + ".target";
            System.IO.Directory.Move(path, target);
            extraRoots.Add(target);
            Probe.CreateDirectory(path);
            Probe.SetJunction(path, target);
            using var handle = Probe.Open(path);
            Require(Probe.Information(handle).Reparse, "independent_junction_not_reached");
        }
    }
}

[SupportedOSPlatform("windows")]
internal static class Probe
{
    private const uint OpenReparseBackup = 0x02200000;
    private static string CurrentSid { get; } = ReadCurrentSid();
    private static string ReadCurrentSid() { using var identity = WindowsIdentity.GetCurrent(); return identity.User?.Value ?? throw new InvalidDataException("independent_current_sid"); }
    internal sealed record Attempt(bool Success, int NativeError);
    internal sealed record FileIdentity(string VolumeSerial, string FileId);
    internal sealed record InformationRecord(FileIdentity Identity, object Security, bool NonInherited, uint Links, bool Directory, bool DeletePending, bool Reparse, string Length, string CreationTime, string LastWriteTime, string? Sha256);
    internal sealed record TreeEntry(string Path, InformationRecord File);
    internal sealed record MutableEntry(string Leaf, Attempt Write, Attempt Delete, Attempt Rename);
    internal sealed record PinEntry(string Leaf, bool Present, int Matches, bool ReadData, bool NonInherited, bool ReadOnly);
    private sealed record ActualHandle(FileIdentity Identity, uint Access, bool NonInherited);

    internal sealed record DataReadAttempt(int OpenError, int? ReadError, uint BytesRead, bool HandleClosed);

    internal static DataReadAttempt ReadDataByte(string path)
    {
        var file = CreateFileW(path, 0x00000001, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        int openError = file.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        int? readError = null;
        uint read = 0;
        try
        {
            if (openError == 0)
                readError = ReadFile(file, new byte[1], 1, out read, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();
        }
        finally { file.Dispose(); }
        return new(openError, readError, read, file.IsClosed);
    }

    internal static void RestoreDacl(string path, byte[] original)
    {
        var descriptor = new RawSecurityDescriptor(original, 0);
        // Windows consumes the request bit when restoring the captured auto-inherited state.
        if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0)
            descriptor.SetFlags(descriptor.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
        var bytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes, 0);
        using var file = CreateFileW(path, 0x00060000, 7, IntPtr.Zero, 3, OpenReparseBackup, IntPtr.Zero);
        Check(!file.IsInvalid, "model_leaf_restore_open");
        Check(SetKernelObjectSecurity(file, 4, bytes), "model_leaf_restore_dacl");
    }

    internal static void Check(bool condition, string stage, int? error = null)
    {
        if (condition) return;
        var failure = new Win32Exception(error ?? Marshal.GetLastWin32Error(), stage);
        failure.Data["fixtureStage"] = stage;
        throw failure;
    }
    internal static SafeFileHandle Open(string path, bool strict = false)
    {
        var handle = CreateFileW(path, 0x80000000, strict ? 1u : 7u, IntPtr.Zero, 3, OpenReparseBackup, IntPtr.Zero);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); Check(false, "independent_open", error); }
        return handle;
    }
    internal static void CreateDirectory(string path)
    {
        var security = new DirectorySecurity();
        var sid = new SecurityIdentifier(CurrentSid);
        security.SetOwner(sid);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(sid, (FileSystemRights)0x001f01ff, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).Create(security);
    }
    internal static void CreateFile(string path, byte[] bytes)
    {
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:" + CurrentSid + "D:P(A;;0x001f01ff;;;" + CurrentSid + ")", 1, out var descriptor, out _), "independent_file_descriptor");
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false };
            using var handle = CreateFileW(path, 0xc0010000, 7, ref attributes, 1, 0x00200080, IntPtr.Zero);
            Check(!handle.IsInvalid, "independent_create_file");
            Check(WriteFile(handle, bytes, checked((uint)bytes.Length), out var written, IntPtr.Zero), "independent_write_file");
            Program.Require(written == bytes.Length, "independent_partial_write");
            Check(FlushFileBuffers(handle), "independent_flush_file");
        }
        finally { LocalFree(descriptor); }
    }
    internal static FileIdentity Identity(SafeFileHandle handle)
    {
        var memory = Marshal.AllocHGlobal(24);
        try
        {
            Check(GetFileInformationByHandleEx(handle, 18, memory, 24), "independent_file_id");
            var bytes = new byte[16]; Marshal.Copy(IntPtr.Add(memory, 8), bytes, 0, bytes.Length);
            return new(unchecked((ulong)Marshal.ReadInt64(memory)).ToString(CultureInfo.InvariantCulture), Convert.ToHexStringLower(bytes));
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    private static bool NonInherited(SafeHandle handle) { Check(GetHandleInformation(handle, out var flags), "independent_handle_flags"); return (flags & 1) == 0; }
    internal static InformationRecord Information(SafeFileHandle handle)
    {
        Check(GetFileInformationByHandleEx(handle, 1, out FileStandard standard, (uint)Marshal.SizeOf<FileStandard>()), "independent_file_standard");
        Check(GetFileInformationByHandleEx(handle, 0, out FileBasic basic, (uint)Marshal.SizeOf<FileBasic>()), "independent_file_basic");
        return new(Identity(handle), Security(handle), NonInherited(handle), standard.Links, standard.Directory, standard.DeletePending, (basic.Attributes & 0x400) != 0, standard.EndOfFile.ToString(CultureInfo.InvariantCulture), basic.CreationTime.ToString(CultureInfo.InvariantCulture), basic.LastWriteTime.ToString(CultureInfo.InvariantCulture), standard.Directory ? null : Hash(handle));
    }
    internal static InformationRecord Inspect(string path) { using var handle = Open(path); return Information(handle); }
    internal static object[] Files(IEnumerable<string> paths) => paths.Select(path => (object)Inspect(path)).ToArray();
    internal static string Hash(SafeFileHandle handle)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[64 * 1024];
        long offset = 0;
        int read;
        while ((read = RandomAccess.Read(handle, buffer, offset)) != 0) { hash.AppendData(buffer, 0, read); offset = checked(offset + read); }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    private static object Security(SafeFileHandle handle)
    {
        var error = GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out var descriptor);
        Check(error == 0, "independent_security", (int)error);
        try
        {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0);
            var acl = security.DiscretionaryAcl;
            var aces = acl is null ? Array.Empty<object>() : acl.Cast<GenericAce>().Select(ace => (object)new { type = ace.AceType.ToString(), flags = (int)ace.AceFlags, accessMask = ace is KnownAce known ? known.AccessMask : 0, sidMatchesCurrent = ace is KnownAce named && named.SecurityIdentifier.Value == CurrentSid }).ToArray();
            return new { ownerMatchesCurrentSid = security.Owner?.Value == CurrentSid, daclPresent = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclPresent), protectedDacl = security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected), aceCount = acl?.Count ?? 0, aces };
        }
        finally { LocalFree(descriptor); }
    }
    internal static void RequireProtected(SafeFileHandle handle)
    {
        var information = Information(handle);
        var security = JsonSerializer.SerializeToElement(information.Security, Program.Json);
        Program.Require(information.NonInherited && !information.DeletePending && !information.Reparse && (information.Directory || information.Links == 1), "independent_ordinary_file");
        var aces = security.GetProperty("aces");
        Program.Require(security.GetProperty("ownerMatchesCurrentSid").GetBoolean() && security.GetProperty("daclPresent").GetBoolean() && security.GetProperty("protectedDacl").GetBoolean() && security.GetProperty("aceCount").GetInt32() == 1, "independent_protected_dacl");
        Program.Require(aces[0].GetProperty("type").GetString() == "AccessAllowed" && aces[0].GetProperty("flags").GetInt32() == 0 && aces[0].GetProperty("accessMask").GetInt32() == 0x001f01ff && aces[0].GetProperty("sidMatchesCurrent").GetBoolean(), "independent_exact_ace");
    }
    internal static object Volume(string path, SafeFileHandle handle)
    {
        var mount = new StringBuilder(32768); Check(GetVolumePathNameW(path, mount, (uint)mount.Capacity), "independent_mount");
        var guid = new StringBuilder(32768); Check(GetVolumeNameForVolumeMountPointW(mount.ToString(), guid, (uint)guid.Capacity), "independent_volume_guid");
        var name = new StringBuilder(32768); var filesystem = new StringBuilder(32768);
        Check(GetVolumeInformationByHandleW(handle, name, (uint)name.Capacity, out _, out _, out var flags, filesystem, (uint)filesystem.Capacity), "independent_volume_information");
        var actual = FinalPath(handle);
        var driveType = GetDriveTypeW(mount.ToString());
        var mapped = guid.ToString().StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) && actual.StartsWith(guid.ToString(), StringComparison.OrdinalIgnoreCase);
        Program.Require(filesystem.ToString() == "NTFS" && driveType == 3 && (flags & 8) != 0 && mapped, "independent_fixed_ntfs_required");
        return new { filesystem = filesystem.ToString(), driveType, persistentAcls = (flags & 8) != 0, guidMapped = mapped };
    }
    private static string FinalPath(SafeFileHandle handle)
    {
        var required = GetFinalPathNameByHandleW(handle, null, 0, 1); Check(required > 0, "independent_guid_path_size");
        var text = new StringBuilder(checked((int)required));
        var count = GetFinalPathNameByHandleW(handle, text, (uint)text.Capacity, 1); Check(count > 0 && count < text.Capacity, "independent_guid_path");
        return text.ToString();
    }
    internal static bool SameObject(string left, string right) { using var first = Open(left); using var second = Open(right); return Identity(first) == Identity(second); }
    internal static object BundleBinding(string[] paths)
    {
        using var root = Open(paths[0]);
        var rootIdentity = Identity(root);
        var rootPath = FinalPath(root);
        var information = paths.Select(Inspect).ToArray();
        var parentsBound = paths.All(path =>
        {
            using var file = Open(path);
            var relative = Path.GetRelativePath(paths[0], path);
            return FinalPath(file) == (relative == "." ? rootPath : Path.Combine(rootPath, relative));
        });
        return new { sameVolume = information.All(file => file.Identity.VolumeSerial == rootIdentity.VolumeSerial), distinctObjectIdentities = information.Select(file => file.Identity).Distinct().Count() == paths.Length, actualParentPathsBound = parentsBound };
    }
    internal static IEnumerable<TreeEntry> Tree(string root)
    {
        if (!File.Exists(root) && !Directory.Exists(root)) yield break;
        var information = Inspect(root);
        yield return new(root, information);
        if (!information.Directory || information.Reparse) yield break;
        foreach (var path in Directory.EnumerateFileSystemEntries(root).Order(StringComparer.Ordinal)) foreach (var entry in Tree(path)) yield return entry;
    }
    private static Attempt OpenAttempt(string path, uint access)
    {
        using var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, OpenReparseBackup, IntPtr.Zero);
        return new(!handle.IsInvalid, handle.IsInvalid ? Marshal.GetLastWin32Error() : 0);
    }
    private static Attempt WriteAttempt(string path)
    {
        var directory = (File.GetAttributes(path) & FileAttributes.Directory) != 0;
        byte[] bytes = directory ? [] : File.ReadAllBytes(path);
        using var handle = CreateFileW(path, 0x40000000, 7, IntPtr.Zero, 3, OpenReparseBackup, IntPtr.Zero);
        if (handle.IsInvalid) return new(false, Marshal.GetLastWin32Error());
        if (directory) return new(true, 0);
        Program.Require(bytes.Length > 0, "independent_write_probe_empty_payload");
        var success = WriteFile(handle, [bytes[0]], 1, out var written, IntPtr.Zero);
        var error = success ? 0 : Marshal.GetLastWin32Error();
        if (success) Program.Require(written == 1, "independent_write_probe_partial");
        return new(success, error);
    }
    private static Attempt DeleteAttempt(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.Directory) != 0) return OpenAttempt(path, 0x00010000);
        var success = DeleteFileW(path);
        return new(success, success ? 0 : Marshal.GetLastWin32Error());
    }
    private static Attempt RenameAttempt(string path)
    {
        var destination = path + ".rename-probe";
        Program.Require(!File.Exists(destination) && !Directory.Exists(destination), "independent_rename_target_exists");
        var success = MoveFileExW(path, destination, 0);
        var error = success ? 0 : Marshal.GetLastWin32Error();
        if (success) Check(MoveFileExW(destination, path, 0), "independent_rename_restore");
        return new(success, error);
    }
    internal static MutableEntry[] Mutable(IEnumerable<string> paths) => paths.Select(path => new MutableEntry(Path.GetFileName(path), WriteAttempt(path), OpenAttempt(path, 0x00010000), RenameAttempt(path))).ToArray();
    internal static bool IsMutable(MutableEntry entry) => entry.Write.Success && entry.Delete.Success && entry.Rename.Success;
    internal static object Denied(IEnumerable<string> paths) => paths.Select(path => new MutableEntry(Path.GetFileName(path), WriteAttempt(path), DeleteAttempt(path), RenameAttempt(path))).ToArray();
    internal static bool AllDenied(object value) => ((MutableEntry[])value).All(entry => !entry.Write.Success && !entry.Delete.Success && !entry.Rename.Success && new[] { entry.Write.NativeError, entry.Delete.NativeError, entry.Rename.NativeError }.All(error => error is 5 or 32));

    // Query only this fixture process. A zero-byte call can report just the
    // header, so negotiate only strictly larger OS-reported buffer sizes.
    // This is API sizing, not a test/engine execution retry or process scan.
    private static ActualHandle[] OwnFileHandles()
    {
        const int lengthMismatch = unchecked((int)0xc0000004u);
        var entryBytes = Marshal.SizeOf<HandleEntry>();
        var headerBytes = checked((int)Marshal.OffsetOf<HandleSnapshot>(nameof(HandleSnapshot.FirstEntry)).ToInt64());
        var minimumBytes = Marshal.SizeOf<HandleSnapshot>();
        Program.Require(IntPtr.Size == 8 && entryBytes == 40 && headerBytes == 16 && minimumBytes == 56, "independent_own_handle_snapshot_layout");
        var memory = IntPtr.Zero;
        uint capacity = 0;
        try
        {
            int status;
            uint returned;
            while (true)
            {
                status = NtQueryInformationProcess(new IntPtr(-1), 51, memory, capacity, out returned);
                if (status != lengthMismatch) break;
                if (returned < headerBytes || returned <= capacity) throw SnapshotFailure("independent_own_handle_snapshot_size", status, capacity, returned);
                var larger = Marshal.AllocHGlobal(checked((int)returned));
                Marshal.WriteInt64(larger, 0, 0);
                Marshal.WriteInt64(larger, IntPtr.Size, 0);
                if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
                memory = larger;
                capacity = returned;
            }
            if (status != 0) throw SnapshotFailure("independent_own_handle_snapshot_unavailable", status, capacity, returned);
            if (memory == IntPtr.Zero || returned < minimumBytes || returned > capacity) throw SnapshotFailure("independent_own_handle_snapshot_bounds", status, capacity, returned);
            var count = unchecked((ulong)Marshal.ReadInt64(memory));
            // This live fixture retains its standard streams; an untouched
            // zero header is not usable evidence of an empty self handle table.
            if (count == 0 || count > (returned - (uint)headerBytes) / (uint)entryBytes) throw SnapshotFailure("independent_own_handle_snapshot_count", status, capacity, returned);
            var handles = new List<ActualHandle>();
            for (ulong index = 0; index < count; index++)
            {
                var entry = Marshal.PtrToStructure<HandleEntry>(IntPtr.Add(memory, checked(headerBytes + (int)index * entryBytes)));
                using var handle = new SafeFileHandle(entry.Value, ownsHandle: false);
                if (GetFileType(handle) != 1) continue;
                var identityMemory = Marshal.AllocHGlobal(24);
                try
                {
                    if (!GetFileInformationByHandleEx(handle, 18, identityMemory, 24)) continue;
                    var id = new byte[16]; Marshal.Copy(IntPtr.Add(identityMemory, 8), id, 0, id.Length);
                    var identity = new FileIdentity(unchecked((ulong)Marshal.ReadInt64(identityMemory)).ToString(CultureInfo.InvariantCulture), Convert.ToHexStringLower(id));
                    handles.Add(new(identity, entry.GrantedAccess, NonInherited(handle)));
                }
                finally { Marshal.FreeHGlobal(identityMemory); }
            }
            return handles.ToArray();
        }
        finally { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
    }
    private static Exception SnapshotFailure(string stage, int status, uint capacity, uint returned)
    {
        var failure = new InvalidDataException(stage);
        failure.Data["fixtureSnapshot"] = new { ntStatus = unchecked((uint)status).ToString("x8", CultureInfo.InvariantCulture), allocatedBytes = capacity, returnedBytes = returned };
        return failure;
    }
    private static (string Path, FileIdentity Identity)[] Known(IEnumerable<string> paths) => paths.Where(path => File.Exists(path) || Directory.Exists(path)).Select(path => { using var handle = Open(path); return (Path: path, Identity: Identity(handle)); }).ToArray();
    internal static PinEntry[] Pins(IEnumerable<string> paths)
    {
        var known = Known(paths);
        var handles = OwnFileHandles();
        return known.Select(item =>
        {
            var matches = handles.Where(handle => handle.Identity == item.Identity).ToArray();
            return new PinEntry(Path.GetFileName(item.Path), matches.Length > 0, matches.Length, matches.Any(handle => (handle.Access & 1) != 0), matches.Length > 0 && matches.All(handle => handle.NonInherited), matches.Length > 0 && matches.All(handle => (handle.Access & 0x000d0116) == 0));
        }).ToArray();
    }
    internal static object[] ActivePins(IEnumerable<string> paths) => Pins(paths).Where(pin => pin.Present).Cast<object>().ToArray();
    internal static void AddExtraAce(string path)
    {
        var extra = new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), FileSystemRights.Read, AccessControlType.Allow);
        if (Directory.Exists(path)) { var directory = new DirectoryInfo(path); var security = directory.GetAccessControl(AccessControlSections.Access); security.AddAccessRule(extra); directory.SetAccessControl(security); }
        else { var file = new FileInfo(path); var security = file.GetAccessControl(AccessControlSections.Access); security.AddAccessRule(extra); file.SetAccessControl(security); }
    }
    internal static void SetJunction(string alias, string target)
    {
        var substitute = Encoding.Unicode.GetBytes(@"\??\" + Path.GetFullPath(target));
        var print = Encoding.Unicode.GetBytes(Path.GetFullPath(target));
        var dataLength = checked(8 + substitute.Length + 2 + print.Length + 2);
        var bytes = new byte[8 + dataLength];
        BitConverter.GetBytes(0xa0000003u).CopyTo(bytes, 0);
        BitConverter.GetBytes(checked((ushort)dataLength)).CopyTo(bytes, 4);
        BitConverter.GetBytes(checked((ushort)substitute.Length)).CopyTo(bytes, 10);
        BitConverter.GetBytes(checked((ushort)(substitute.Length + 2))).CopyTo(bytes, 12);
        BitConverter.GetBytes(checked((ushort)print.Length)).CopyTo(bytes, 14);
        substitute.CopyTo(bytes, 16); print.CopyTo(bytes, 16 + substitute.Length + 2);
        using var directory = CreateFileW(alias, 0x40000000, 7, IntPtr.Zero, 3, OpenReparseBackup, IntPtr.Zero);
        Check(!directory.IsInvalid, "independent_junction_open");
        Check(DeviceIoControl(directory, 0x000900a4, bytes, checked((uint)bytes.Length), IntPtr.Zero, 0, out _, IntPtr.Zero), "independent_junction_create");
    }

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint securityInformation, byte[] descriptor);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(SafeFileHandle handle, [Out] byte[] bytes, uint length, out uint read, IntPtr overlapped);
    [StructLayout(LayoutKind.Sequential)] private struct FileStandard { internal long AllocationSize, EndOfFile; internal uint Links; [MarshalAs(UnmanagedType.U1)] internal bool DeletePending; [MarshalAs(UnmanagedType.U1)] internal bool Directory; }
    [StructLayout(LayoutKind.Sequential)] private struct FileBasic { internal long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct HandleEntry { internal IntPtr Value; internal UIntPtr HandleCount, PointerCount; internal uint GrantedAccess, ObjectTypeIndex, HandleAttributes, Reserved; }
    [StructLayout(LayoutKind.Sequential)] private struct HandleSnapshot { internal UIntPtr NumberOfHandles, Reserved; internal HandleEntry FirstEntry; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, ref SecurityAttributes security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool WriteFile(SafeFileHandle handle, byte[] bytes, uint length, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, IntPtr information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileStandard information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileBasic information, uint bytes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumePathNameW(string path, StringBuilder mount, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeNameForVolumeMountPointW(string mount, StringBuilder name, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder name, uint nameLength, out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder filesystem, uint filesystemLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder? path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateHardLinkW(string newName, string existingName, IntPtr security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeleteFileW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool MoveFileExW(string oldName, string newName, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, uint inputLength, IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr information, uint bytes, out uint returned);
}
