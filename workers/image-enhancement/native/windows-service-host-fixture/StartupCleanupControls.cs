using System.Reflection;
using System.Text.Json;
using Zeb.WindowsServiceHost;
using Zeb.WindowsSupervisor;

namespace Zeb.WindowsServiceHostFixture;

internal static partial class Program
{
    private static JsonElement OriginalStartupSettlement(ContainedWorkerSession session)
    {
        var field = typeof(ContainedWorkerSession).GetField("startupCleanup", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidDataException("cleanup_controls_original_settlement_field_missing");
        var producer = field.GetValue(session) as TaskCompletionSource<WorkerStartupSettlement>
            ?? throw new InvalidDataException("cleanup_controls_original_settlement_type");
        Require(producer.Task.IsCompletedSuccessfully, "cleanup_controls_original_settlement_not_complete");
        return JsonSerializer.SerializeToElement(producer.Task.Result, Json);
    }

    // A finite method slice: synthetic root facts, no Start, Node, Job, pipe, SCM or physical cleanup claim.
    private static int RunStartupCleanupControls(string path)
    {
        string directory = Path.GetFullPath(path);
        Require(Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any(), "cleanup_controls_empty_directory");
        var flags = BindingFlags.Instance | BindingFlags.NonPublic;
        var save = typeof(ContainedWorkerSession).GetMethod("SaveRoot", flags, null, [typeof(ProcessRootExit)], null)
            ?? throw new InvalidDataException("cleanup_controls_original_save_root_missing");
        var add = typeof(ContainedWorkerSession).GetMethod("AddFailure", flags, null, [typeof(Exception)], null)
            ?? throw new InvalidDataException("cleanup_controls_original_add_failure_missing");
        var errorsField = typeof(ContainedWorkerSession).GetField("failures", flags)
            ?? throw new InvalidDataException("cleanup_controls_original_failures_missing");
        var cases = new List<object>();
        bool passed = true;
        foreach (uint exitCode in new uint[] { 2, 3 })
        {
            using var session = new ContainedWorkerSession(Executable, [], directory, _ => { }, _ => { });
            var synthetic = new ProcessRootExit(new ProcessIdentity(17, 123456789), exitCode);
            save.Invoke(session, [synthetic]);
            var errors = (List<Exception>)(errorsField.GetValue(session)
                ?? throw new InvalidDataException("cleanup_controls_original_failures_null"));
            Require(errors.Count == 1 && errors[0] is InvalidOperationException, "cleanup_controls_original_root_failure_required");
            Exception rootFailure = errors[0];
            bool sameTypeAndMessageIndependent = true;
            if (exitCode == 2)
            {
                var unrelated = new InvalidOperationException(rootFailure.Message);
                sameTypeAndMessageIndependent = !ReferenceEquals(rootFailure, unrelated) && rootFailure.GetType() == unrelated.GetType() &&
                    rootFailure.Message == unrelated.Message;
                add.Invoke(session, [unrelated]);
                add.Invoke(session, [new IOException("public inert cleanup failure sentinel")]);
            }
            save.Invoke(session, [synthetic]);
            Exception[] expectedErrors = errors.ToArray();
            int expectedCount = exitCode == 2 ? 2 : 1;
            Require(expectedErrors.Length == (exitCode == 2 ? 3 : 1), "cleanup_controls_save_root_deduplicates_original_exception");
            Task originalStop = session.StopAsync();
            try { originalStop.GetAwaiter().GetResult(); }
            catch (Exception) when (originalStop.IsFaulted) { }
            JsonElement actual = OriginalStartupSettlement(session);
            var retained = session.Completion.Exception?.InnerExceptions;
            bool originalReferencesRetained = retained is not null && retained.Count == expectedErrors.Length &&
                retained.Select((failure, index) => ReferenceEquals(failure, expectedErrors[index])).All(value => value) &&
                errors.Count == expectedErrors.Length && errors.Select((failure, index) => ReferenceEquals(failure, expectedErrors[index])).All(value => value);
            bool countPresent = actual.TryGetProperty("cleanupFailureCount", out var count);
            bool releasePresent = actual.TryGetProperty("ownerReleaseCompleted", out var release);
            bool countMatches = countPresent && count.ValueKind == JsonValueKind.Number && count.TryGetInt32(out int actualCount) && actualCount == expectedCount;
            bool releaseMatches = releasePresent && release.ValueKind == JsonValueKind.False;
            bool good = countMatches && releaseMatches && sameTypeAndMessageIndependent && originalReferencesRetained && session.Completion.IsFaulted;
            passed &= good;
            cases.Add(new { name = exitCode == 2 ? "exit2_excludes_only_original_root_exception_reference" : "exit3_root_failure_remains_counted",
                exitCode, expectedCleanupFailureCount = expectedCount, expectedOwnerReleaseCompleted = false,
                fieldsPresent = countPresent && releasePresent, countMatches, releaseMatches, originalReferencesRetained,
                sameTypeAndMessageIndependent, completionRemainsFaulted = session.Completion.IsFaulted, actualSettlement = actual,
                failurePoint = good ? null : !countPresent || !releasePresent ? "behavior_red_startup_cleanup_session_fields_required" : "startup_cleanup_reference_count_or_owner_mismatch",
                passed = good });
        }
        return WriteCase(directory, new { passed, cases, caseCount = cases.Count, actualWorkerStarted = false, actualNodeExit = false,
            actualOwnerReleased = false, actualScm = false, actualFailureProof = false,
            scope = "original SaveRoot/AddFailure/CleanupAsync method slice only; synthetic root exit inputs, original Completion errors retained" });
    }
}
