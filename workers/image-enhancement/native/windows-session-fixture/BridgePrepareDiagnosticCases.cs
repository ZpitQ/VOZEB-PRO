using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Text.Json;

namespace Zeb.WindowsSessionFixture;

// Technical state controls over the actual bridge assembly; no helper, engine or service qualification.
internal static class BridgePrepareDiagnosticCases
{
    private const BindingFlags Instance = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
    private const BindingFlags Static = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
    private static object Get(object target, string name) => target.GetType().GetField(name, Instance)?.GetValue(target)
        ?? target.GetType().GetProperty(name, Instance)?.GetValue(target) ?? throw new InvalidDataException(name);
    private static void Set(object target, string name, object? value)
    {
        if (target.GetType().GetField(name, Instance) is FieldInfo field) field.SetValue(target, value);
        else target.GetType().GetProperty(name, Instance)!.SetValue(target, value);
    }
    private static object? Call(object target, string name, params object?[] args) => target.GetType().GetMethod(name, Instance)!.Invoke(target, args);

    internal static async Task<int> RunAsync(string assemblyPath)
    {
        Program.Require(Path.IsPathFullyQualified(assemblyPath), "bridge_diagnostic_fixed_assembly");
        Assembly assembly = Assembly.LoadFrom(assemblyPath);
        Type protocol = assembly.GetType("Zeb.WindowsControlBridge.BridgeProtocol", true)!;
        Type sessionType = assembly.GetType("Zeb.WindowsControlBridge.OriginalControlSession", true)!;
        Type writerType = assembly.GetType("Zeb.WindowsControlBridge.BoundedOutputWriter", true)!;
        Type channelType = sessionType.GetNestedType("OriginalChannel", BindingFlags.NonPublic)!;
        Type operationType = sessionType.GetNestedType("Operation", BindingFlags.NonPublic)!;
        Type commandType = assembly.GetType("Zeb.WindowsControlBridge.BridgeCommand", true)!;
        var rows = new List<object>();
        foreach (string name in new[] { "stdout-eof-before-owner", "no-permit", "caller-close", "request-expired",
            "owner-already-ended", "authorize-pending", "wrong-owner", "session-expired", "deadline-cancel", "write-not-invoked", "observer-unknown-before-owner" })
        {
            string executionId = new('a', 32), requestId = new('b', 32), fingerprint = new('c', 64);
            string op = name == "authorize-pending" ? "authorize" : "prepare";
            string configText = JsonSerializer.Serialize(new { v = 1, helperPath = Environment.ProcessPath!,
                recordsRoot = Path.GetTempPath(), installationRoot = Path.GetTempPath(), expectedManifestSha256 = new string('d', 64),
                environment = new Dictionary<string, string>(), limits = new { maxRequestFrameBytes = 65536, maxResponseFrameBytes = 65536,
                    maxHelperStderrBytes = 8192, maxSessionInputBytes = 262144, maxSessionOutputBytes = 1048576, maxQueuedOutputBytes = 262144,
                    maxJsonDepth = 16, startupTimeoutMs = 60000, requestTimeoutMs = 5000, sessionTimeoutMs = 60000, cleanupTimeoutMs = 5000 } });
            object config = protocol.GetMethod("Configuration", Static)!.Invoke(null, [new[] { "--control-bridge", configText }])!;
            object session = Activator.CreateInstance(sessionType, Instance, null, [config], null)!;
            using var capture = new MemoryStream();
            Action fault = () => Call(session, "Fault");
            object writer = Activator.CreateInstance(writerType, Instance, null, [capture, Get(config, "Limits"), fault], null)!;
            using var ownerPipe = new NamedPipeClientStream(".", "zeb-technical-" + Guid.NewGuid().ToString("N"), PipeDirection.InOut, PipeOptions.Asynchronous);
            using var observerPipe = new NamedPipeClientStream(".", "zeb-technical-" + Guid.NewGuid().ToString("N"), PipeDirection.InOut, PipeOptions.Asynchronous);
            object owner = Activator.CreateInstance(channelType, Instance, null, [ownerPipe, "owner"], null)!;
            object observer = Activator.CreateInstance(channelType, Instance, null, [observerPipe, "observer"], null)!;
            object command = Activator.CreateInstance(commandType, Instance, null,
                [requestId, op, executionId, null, fingerprint, null, false, null, false], null)!;
            long anchor = Stopwatch.GetTimestamp();
            long requestAnchor = name == "request-expired" ? anchor - 6 * Stopwatch.Frequency : anchor;
            object operation = Activator.CreateInstance(operationType, Instance, null, [requestId, op, requestAnchor, command], null)!;
            Set(operation, "PermitRequested", true); Set(operation, "PermitReceived", name != "no-permit");
            ((TaskCompletionSource<bool>)Get(operation, "Permit")).TrySetResult(name != "no-permit");
            Set(operation, "Write", Task.FromResult(true));
            // This field is deliberately optional on the old source: the RED tests behavior, not API absence.
            operationType.GetProperty("WriteInvoked", Instance)?.SetValue(operation, name != "write-not-invoked");
            object channel = name == "wrong-owner" ? observer : owner;
            Get(channel, "Pending").GetType().GetMethod("Add")!.Invoke(Get(channel, "Pending"), [requestId, operation]);
            Set(session, "output", writer); Set(session, "owner", owner); Set(session, "observer", observer);
            Set(session, "ownerPipe", ownerPipe); Set(session, "observerPipe", observerPipe);
            Set(session, "launchAnchor", name == "session-expired" ? anchor - 61 * Stopwatch.Frequency : anchor);
            Set(session, "bound", true); Set(session, "readySeen", true); Set(session, "prepareAccepted", true);
            Set(session, "executionId", executionId); Set(session, "executionCommand", command); Set(session, "executionOperation", operation);
            var response = (TaskCompletionSource<JsonElement?>)Get(operation, "Response");
            if (name == "owner-already-ended") response.TrySetResult(null);
            Task? eof = null;
            bool directError = name is "request-expired" or "wrong-owner" or "session-expired" or "write-not-invoked" or "observer-unknown-before-owner";
            if (!directError) eof = (Task)Call(session, "ReadHelperOutputAsync", new MemoryStream())!;
            // Empty MemoryStream delivers actual EOF synchronously, before this original owner response is supplied.
            bool heldBeforeReply = eof is { IsCompleted: false } && !(bool)Get(session, "isSealed");
            long? observerBytesBeforeReply = null;
            if (name == "observer-unknown-before-owner")
            {
                Set(observer, "Watched", true);
                var eventBytes = new ReadOnlyMemory<byte>(Program.Utf8.GetBytes(JsonSerializer.Serialize(new { v = 1, kind = "event", @event = "state", executionId,
                    state = new { phase = "unknown", sealReason = "evidence-unknown", requestFingerprint = (string?)null,
                        descriptor = (object?)null, authorizationVerified = false, resumeState = "not-attempted", evidenceOutcome = "unknown", completion = (string?)null } })));
                object message = protocol.GetMethod("Native", Static)!.Invoke(null, [eventBytes, 16])!;
                Call(session, "AcceptNative", observer, message, null);
                observerBytesBeforeReply = (long)Get(writer, "admitted");
            }
            bool rejected = false;
            if (name == "caller-close")
            {
                var closeBytes = new ReadOnlyMemory<byte>(Program.Utf8.GetBytes(JsonSerializer.Serialize(new { v = 1, kind = "command",
                    requestId = new string('e', 32), op = "close", executionId })));
                Call(session, "AcceptCommand", closeBytes);
            }
            if (name == "deadline-cancel") fault();
            if (name is not ("owner-already-ended" or "authorize-pending" or "no-permit" or "deadline-cancel"))
            {
                var errorBytes = new ReadOnlyMemory<byte>(Program.Utf8.GetBytes(JsonSerializer.Serialize(new { v = 1, kind = "error", requestId,
                    code = "unknown", prepareDiagnostic = new { prepareStage = "installation_open", nativeStage = "file_open", nativeErrorCode = 5 } })));
                object message = protocol.GetMethod("Native", Static)!.Invoke(null, [errorBytes, 16])!;
                try { Call(session, "AcceptNative", channel, message, null); }
                catch (TargetInvocationException error) when (error.InnerException is InvalidDataException) { rejected = true; fault(); }
            }
            if (eof is not null) await eof.WaitAsync(TimeSpan.FromSeconds(5));
            if (!(bool)Get(session, "isSealed")) fault();
            Call(writer, "Seal");
            await ((Task)Get(writer, "Completion")).WaitAsync(TimeSpan.FromSeconds(5));
            var frames = Program.Utf8.GetString(capture.ToArray()).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(Program.Parse).ToArray();
            rows.Add(new { name, heldBeforeReply, observerBytesBeforeReply, rejected, frames, sealedSession = Get(session, "isSealed"),
                noEngineOrService = true, syntheticPendingOwner = true });
            if (sessionType.GetField("cleanupDeadline", Instance)!.GetValue(session) is IAsyncDisposable timer) await timer.DisposeAsync();
            ((CancellationTokenSource)Get(session, "admissionCancellation")).Dispose();
            ((CancellationTokenSource)Get(session, "pipeCancellation")).Dispose();
            ((SemaphoreSlim)Get(owner, "Writer")).Dispose(); ((SemaphoreSlim)Get(observer, "Writer")).Dispose();
        }
        Program.Write(new { kind = "bridge-prepare-diagnostic-controls", assemblySha256 = Program.Hash(File.ReadAllBytes(assemblyPath)), rows });
        return 0;
    }
}
