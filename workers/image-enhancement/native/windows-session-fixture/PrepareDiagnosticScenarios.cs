using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsSessionFixture;

// Test-only fault setup over this case's own bundle. No production parser or diagnostic is copied.
internal static class PrepareDiagnosticScenarios
{
    internal sealed class Fault : IDisposable
    {
        private const AccessControlSections Sections = AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access;
        private readonly RunContext run;
        private readonly bool directory;
        private readonly string target, originalSddl;
        private readonly byte[] originalDescriptor;
        private readonly (string Path, string Sddl)[] ancestors;
        private readonly JsonElement bundleBefore;
        private readonly ResolvedEngineLaunch launch;
        private bool restored;
        internal Dictionary<string, object?> Trace { get; } = [];

        internal Fault(RunContext run, bool reservation)
        {
            this.run = run;
            directory = reservation;
            using (var impersonation = WindowsIdentity.GetCurrent(ifImpersonating: true))
                Program.Require(impersonation is null, "prepare_diagnostic_plain_caller");
            using var identity = WindowsIdentity.GetCurrent();
            var sid = identity.User ?? throw new InvalidDataException("prepare_diagnostic_caller_sid");
            using (var installation = TrustedInstallation.Open(run.Bundle.Root, run.Bundle.ManifestSha256, run.Bundle.Selection))
            {
                launch = installation.Launch;
                Program.Require(string.Equals(Path.Combine(launch.ModelDirectory, launch.ModelName + ".bin"),
                    run.Bundle.ModelBin, StringComparison.OrdinalIgnoreCase), "prepare_diagnostic_production_selected_model");
            }
            Program.Require(Directory.GetFileSystemEntries(run.RecordsRoot).Length == 0, "prepare_diagnostic_empty_records_before");
            bundleBefore = Program.Element(run.Bundle.Snapshot());
            target = reservation ? run.RecordsRoot : Path.Combine(launch.ModelDirectory, launch.ModelName + ".bin");
            var original = Access();
            originalDescriptor = original.GetSecurityDescriptorBinaryForm();
            originalSddl = original.GetSecurityDescriptorSddlForm(Sections);
            var parents = new List<(string Path, string Sddl)>();
            for (var parent = Directory.GetParent(target); parent is not null; parent = parent.Parent)
                parents.Add((parent.FullName, parent.GetAccessControl().GetSecurityDescriptorSddlForm(Sections)));
            ancestors = parents.ToArray();
            Trace["kind"] = reservation ? "records-list-directory-denied" : "production-selected-model-read-data-denied";
            Trace["selectedFromProductionLaunch"] = !reservation;
            Trace["originalCallerUnimpersonated"] = true;
            try
            {
                var rule = new FileSystemAccessRule(sid, reservation ? FileSystemRights.ListDirectory : FileSystemRights.ReadData,
                    InheritanceFlags.None, PropagationFlags.None, AccessControlType.Deny);
                if (reservation)
                {
                    var denied = new DirectorySecurity();
                    denied.SetSecurityDescriptorBinaryForm(originalDescriptor, AccessControlSections.Access);
                    denied.AddAccessRule(rule);
                    new DirectoryInfo(target).SetAccessControl(denied);
                }
                else
                {
                    var denied = new FileSecurity();
                    denied.SetSecurityDescriptorBinaryForm(originalDescriptor, AccessControlSections.Access);
                    denied.AddAccessRule(rule);
                    new FileInfo(target).SetAccessControl(denied);
                }
                bool installed = Access().GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
                    .Any(value => value.IdentityReference.Equals(sid) && !value.IsInherited &&
                        value.AccessControlType == AccessControlType.Deny && (int)value.FileSystemRights == 1 &&
                        value.InheritanceFlags == InheritanceFlags.None && value.PropagationFlags == PropagationFlags.None);
                var deniedRead = Probe.OpenAttempt(target, 1);
                var readableControl = Probe.OpenAttempt(run.Bundle.ModelParam, 1);
                bool ancestorsUnchanged = AncestorsUnchanged();
                Trace["denyInstalled"] = installed;
                Trace["deniedRead"] = deniedRead;
                Trace["readableControl"] = readableControl;
                Trace["ancestorAclsUnchangedDuring"] = ancestorsUnchanged;
                Program.Require(installed && !deniedRead.Success && deniedRead.NativeError == 5 &&
                    readableControl.Success && ancestorsUnchanged, "prepare_diagnostic_real_denial_setup");
                if (reservation)
                {
                    // This independent read-only call reaches the same real PinRoot failure; it cannot reserve.
                    var probe = ProtectedJournal.InspectReservation(run.RecordsRoot, run.Scope);
                    Trace["independentReservationRead"] = Readback.Result(probe);
                    Program.Require(probe.Status == JournalStatus.Unknown && probe.Owner is null && probe.Snapshot is null &&
                        probe.Diagnostic is { Stage: "directory_open", NativeError: 5 }, "prepare_diagnostic_actual_journal_diagnostic");
                }
            }
            catch { Restore(); throw; }
        }

        private FileSystemSecurity Access() => directory
            ? new DirectoryInfo(target).GetAccessControl() : new FileInfo(target).GetAccessControl();
        private bool AncestorsUnchanged() => ancestors.All(value =>
            new DirectoryInfo(value.Path).GetAccessControl().GetSecurityDescriptorSddlForm(Sections) == value.Sddl);

        internal void Restore()
        {
            if (restored) return;
            var descriptor = new RawSecurityDescriptor(originalDescriptor, 0);
            if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0)
                descriptor.SetFlags(descriptor.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
            var bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            using (var file = CreateFileW(target, 0x00060000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
            {
                Probe.Check(!file.IsInvalid, "prepare_diagnostic_restore_original_open");
                Probe.Check(SetKernelObjectSecurity(file, 4, bytes), "prepare_diagnostic_restore_original_dacl");
            }
            // Mark restored after the exact DACL write, before any independent observation can fail.
            restored = true;
            Trace["leafAclRestored"] = Access().GetSecurityDescriptorSddlForm(Sections) == originalSddl;
            Trace["ancestorAclsUnchangedAfter"] = AncestorsUnchanged();
            Trace["bundlePreserved"] = JsonElement.DeepEquals(bundleBefore, Program.Element(run.Bundle.Snapshot()));
            Trace["recordsEmpty"] = Directory.GetFileSystemEntries(run.RecordsRoot).Length == 0;
            using var reopened = TrustedInstallation.Open(run.Bundle.Root, run.Bundle.ManifestSha256, run.Bundle.Selection);
            Trace["bindingPreserved"] = reopened.Launch == launch;
            Program.Require(Trace["leafAclRestored"] is true && Trace["ancestorAclsUnchangedAfter"] is true &&
                Trace["bundlePreserved"] is true && Trace["recordsEmpty"] is true && Trace["bindingPreserved"] is true,
                "prepare_diagnostic_restoration_or_preservation");
        }

        public void Dispose() => Restore();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor);
    }

    internal static async Task RunAsync(RunContext run, CancellationToken token)
    {
        bool reservation = run.Scenario == "prepare-diagnostic-reservation-denied";
        Program.Require(reservation || run.Scenario == "prepare-diagnostic-installation-denied", "prepare_diagnostic_frozen_scenario");
        var session = await run.SessionAsync(token);
        using var fault = new Fault(run, reservation);
        run.Values["prepareDiagnosticFault"] = fault.Trace;
        var request = run.PrepareRequest(session);
        run.Values["prepareDiagnosticRequest"] = request;
        var result = await run.ExchangeFrameAsync(session, request, token);
        // Baseline missing diagnostics remain observable data so the TS capability assertion supplies RED.
        run.Values["prepareDiagnosticResponse"] = result;
        run.Values["prepareDiagnosticUnknownEvent"] = await run.EventAsync(session, "evidenceOutcome", "unknown", token);
        var state = ((JsonElement)run.Values["prepareDiagnosticUnknownEvent"]!).GetProperty("state");
        Program.Require(Program.Text(result, "kind") == "error" && Program.Text(result, "code") == "unknown" &&
            Program.Text(result, "requestId") == Program.Text(request, "requestId") &&
            Program.Text(state, "phase") == "unknown" && Program.Text(state, "evidenceOutcome") == "unknown" &&
            state.GetProperty("completion").ValueKind == JsonValueKind.Null && !File.Exists(run.Marker) &&
            run.EnginePins.Count == 0, "prepare_diagnostic_original_unknown_authority");
        fault.Restore();
        // Failure before JobProcess.Prepare exits naturally; it grants no durable recovery receipt.
        await session.Subject.JoinAsync(token);
        Program.Require(session.Subject.Pin.ExitCode == 2 && !session.Subject.Forced, "prepare_diagnostic_original_natural_unknown_exit");
        run.Values["prepareDiagnosticContainment"] = new { originalUnknownObserved = true,
            exactOriginalHelperJoined = session.Subject.Pin.Joined, forcedFaultCleanup = false,
            helperNaturalExit = true, helperExitCode = session.Subject.Pin.ExitCode,
            engineCreated = false, terminalAbsent = !File.Exists(Readback.RecordPath(run.RecordsRoot, run.Scope, Readback.TerminalId)),
            firstActionAbsent = !File.Exists(run.Marker), productCleanupQualified = false };
    }
}
