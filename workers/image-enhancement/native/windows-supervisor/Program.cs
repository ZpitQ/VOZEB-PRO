using System.Globalization;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Zeb.WindowsSupervisor;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        string stage = "bootstrap";
        try
        {
            if (args.Length == 2 && args[0] == "--read-records")
            {
                stage = "reader_cli";
                if (!LocalRoot(args[1])) throw new ArgumentException();
                return await NativeRecoveryReader.RunAsync(args[1]);
            }
            Bootstrap bootstrap = ParseBootstrap(args);
            string leaf = bootstrap.Leaf;
            uint pid = bootstrap.Pid;
            using ControlProcess current = ControlProcess.Open((uint)Environment.ProcessId);
            using ControlProcess controller = ControlProcess.Open(pid);
            if (!controller.User.Equals(current.User))
                throw new InvalidOperationException();
            controller.RequireRunning();

            using NamedPipeServerStream first = ControlNativeMethods.CreatePipe(leaf, current.User, true);
            var control = new ControlSession(controller, current, bootstrap);
            if (control.Execution is not null)
            {
                stage = "execution";
                return await RunExecutionAsync(leaf, current, controller, first, control);
            }
            Task exited = Task.Run(() =>
            {
                controller.WaitForExit();
                control.ControllerExited();
            });
            Task accepts = AcceptAsync(leaf, current, first, control);
            if (accepts.IsCompleted) await accepts;
            if (exited.IsFaulted) await exited;
            Console.Out.WriteLine(JsonSerializer.Serialize(new
            {
                v = 1, kind = "ready", executionId = control.ExecutionId,
            }));
            Console.Out.Flush();
            stage = "control";
            Task finished = await Task.WhenAny(accepts, exited);
            await finished;
            await accepts;
            return 0;
        }
        catch
        {
            Log("control_failure", stage);
            return 2;
        }
    }

    private sealed record Bootstrap(string Leaf, uint Pid, string? RecordsRoot,
        string? InstallationRoot, string? ManifestSha256);

    private static Bootstrap ParseBootstrap(string[] args)
    {
        if (args.Length is not (4 or 10)) throw new ArgumentException();
        string? leaf = null;
        uint? pid = null;
        string? recordsRoot = null, installationRoot = null, manifest = null;
        for (int index = 0; index < args.Length; index += 2)
        {
            if (args[index] == "--pipe" && leaf is null)
                leaf = args[index + 1];
            else if (args[index] == "--controller-pid" && pid is null &&
                     uint.TryParse(args[index + 1], NumberStyles.None, CultureInfo.InvariantCulture, out uint parsed) &&
                     parsed != 0)
                pid = parsed;
            else if (args.Length == 10 && args[index] == "--records-root" && recordsRoot is null)
                recordsRoot = args[index + 1];
            else if (args.Length == 10 && args[index] == "--installation-root" && installationRoot is null)
                installationRoot = args[index + 1];
            else if (args.Length == 10 && args[index] == "--expected-manifest-sha256" && manifest is null)
                manifest = args[index + 1];
            else
                throw new ArgumentException();
        }
        const string prefix = "zeb-control-";
        if (leaf is null || pid is null || leaf.Length != prefix.Length + 32 ||
            !leaf.StartsWith(prefix, StringComparison.Ordinal))
            throw new ArgumentException();
        foreach (char value in leaf.AsSpan(prefix.Length))
            if (!(value is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new ArgumentException();
        if (args.Length == 10)
        {
            if (!LocalRoot(recordsRoot) || !LocalRoot(installationRoot) || manifest is null ||
                !NativeExecutionSession.Hex(manifest, 64)) throw new ArgumentException();
        }
        return new(leaf, pid.Value, recordsRoot, installationRoot, manifest);
    }

    private static bool LocalRoot(string? value) => value is { Length: >= 3 } &&
        char.IsAsciiLetter(value[0]) && value[1] == ':' && (value[2] is '\\' or '/') &&
        !value.Contains('\0') && Path.IsPathFullyQualified(value) && new UTF8Encoding(false, true).GetByteCount(value) > 0;

    private static async Task<int> RunExecutionAsync(string leaf, ControlProcess current,
        ControlProcess controller, NamedPipeServerStream first, ControlSession control)
    {
        using var shutdown = new CancellationTokenSource();
        Task watcher = WatchControllerAsync(controller, control, shutdown.Token);
        Task retained = ReuseExecutionFirstAsync(first, current, control, shutdown.Token);
        Task additional = AcceptExecutionAdditionalAsync(leaf, current, control, shutdown.Token);
        Console.Out.WriteLine(JsonSerializer.Serialize(new { v = 1, kind = "ready", executionId = control.ExecutionId }));
        Console.Out.Flush();
        // Unknown with an unproved original tree deliberately keeps this wait and all original pins alive.
        int code = await control.Execution!.Completion;
        if (control.Execution.RemainingPrepareFailureReplyMilliseconds is int remaining)
        {
            control.SealRequests();
            if (remaining == 0) code = 2;
            else
            {
                using var replyDeadline = new CancellationTokenSource(remaining);
                try
                {
                    await control.DrainResponsesAsync(replyDeadline.Token);
                    if (control.Execution.RemainingPrepareFailureReplyMilliseconds is not > 0) code = 2;
                }
                catch { code = 2; }
            }
        }
        control.BeginShutdown();
        shutdown.Cancel();
        try { await Task.WhenAll(retained, additional); } catch { code = 2; }
        control.CloseConnections();
        try { await control.JoinConnectionsAsync(); } catch { code = 2; }
        try { await control.JoinOperationsAsync(); } catch { code = 2; }
        try { await watcher; } catch { code = 2; }
        return code;
    }

    private static async Task WatchControllerAsync(ControlProcess controller, ControlSession control,
        CancellationToken token)
    {
        try
        {
            await controller.WaitForExitAsync(token);
            control.ControllerExited();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch { control.Execution!.EvidenceFailed(); }
    }

    private static async Task ReuseExecutionFirstAsync(NamedPipeServerStream first,
        ControlProcess current, ControlSession control, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                await first.WaitForConnectionAsync(token);
                Task connection = RunExecutionConnectionAsync(first, true, current, control);
                control.TrackConnection(connection);
                await connection;
                if (token.IsCancellationRequested || control.ShuttingDown) return;
                first.Disconnect();
            }
        }
        catch (Exception error) when (token.IsCancellationRequested &&
            error is OperationCanceledException or IOException or ObjectDisposedException) { }
        catch { control.Execution!.EvidenceFailed(); }
    }

    private static async Task AcceptExecutionAdditionalAsync(string leaf, ControlProcess current,
        ControlSession control, CancellationToken token)
    {
        NamedPipeServerStream? pending = null;
        try
        {
            while (!token.IsCancellationRequested)
            {
                pending = ControlNativeMethods.CreatePipe(leaf, current.User, false);
                await pending.WaitForConnectionAsync(token);
                NamedPipeServerStream connected = pending;
                pending = null;
                control.TrackConnection(RunExecutionConnectionAsync(connected, false, current, control));
            }
        }
        catch (Exception error) when (token.IsCancellationRequested &&
            error is OperationCanceledException or IOException or ObjectDisposedException) { }
        catch { control.Execution!.EvidenceFailed(); }
        finally { pending?.Dispose(); }
    }

    private static async Task RunExecutionConnectionAsync(NamedPipeServerStream pipe, bool retain,
        ControlProcess current, ControlSession control)
    {
        ControlConnection? connection = null;
        try
        {
            using ControlProcess client = ControlNativeMethods.OpenClient(pipe.SafePipeHandle);
            if (!client.User.Equals(current.User)) throw new InvalidOperationException();
            connection = new ControlConnection(pipe, retain, client, control);
            control.Opened(connection);
            Task writer = connection.WriteAsync();
            try { await ReadRequestsAsync(connection, control); }
            catch (Exception error) when (connection.LocallyClosing &&
                error is OperationCanceledException or IOException or ObjectDisposedException) { }
            catch { control.TransportEnded(connection, TransportClose.ProtocolFailure); }
            finally
            {
                connection.Close(TransportClose.LocalShutdown);
                await writer;
            }
        }
        catch { Log("connection_closed", "execution"); }
        finally
        {
            if (connection is not null) connection.Dispose();
            else if (!retain) pipe.Dispose();
        }
    }

    private static async Task AcceptAsync(string leaf, ControlProcess current,
        NamedPipeServerStream first, ControlSession control)
    {
        await first.WaitForConnectionAsync();
        Task retained = ReuseFirstAsync(first, current, control);
        Task additional = AcceptAdditionalAsync(leaf, current, control);
        Task finished = await Task.WhenAny(retained, additional);
        await finished;
    }

    private static async Task ReuseFirstAsync(NamedPipeServerStream first,
        ControlProcess current, ControlSession control)
    {
        while (true)
        {
            await RunConnectionAsync(first, true, current, control);
            // The old reader, writer and client identity are joined before this handle is reused.
            first.Disconnect();
            await first.WaitForConnectionAsync();
        }
    }

    private static async Task AcceptAdditionalAsync(string leaf,
        ControlProcess current, ControlSession control)
    {
        NamedPipeServerStream? pending = ControlNativeMethods.CreatePipe(leaf, current.User, false);
        try
        {
            while (true)
            {
                await pending.WaitForConnectionAsync();
                NamedPipeServerStream connected = pending;
                pending = null;
                _ = RunConnectionAsync(connected, false, current, control);
                pending = ControlNativeMethods.CreatePipe(leaf, current.User, false);
            }
        }
        finally
        {
            pending?.Dispose();
        }
    }

    private static async Task RunConnectionAsync(NamedPipeServerStream pipe, bool retain,
        ControlProcess current, ControlSession control)
    {
        ControlConnection? connection = null;
        try
        {
            using ControlProcess client = ControlNativeMethods.OpenClient(pipe.SafePipeHandle);
            if (!client.User.Equals(current.User)) throw new InvalidOperationException();
            connection = new ControlConnection(pipe, retain, client, control);
            Task writer = connection.WriteAsync();
            try
            {
                await ReadRequestsAsync(connection, control);
            }
            catch (Exception error) when (error is JsonException or DecoderFallbackException or
                InvalidDataException or ArgumentException or InvalidOperationException)
            {
                connection.Enqueue(Error(null, "invalid_request"));
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException)
            {
            }
            finally
            {
                try { connection.Close(); }
                finally { await writer; }
            }
        }
        catch
        {
            Log("connection_closed", "control");
        }
        finally
        {
            if (connection is not null) connection.Dispose();
            else if (!retain) pipe.Dispose();
        }
    }

    private static async Task ReadRequestsAsync(ControlConnection connection, ControlSession control)
    {
        var encoding = new UTF8Encoding(false, true);
        Decoder decoder = encoding.GetDecoder();
        byte[] bytes = new byte[4096];
        char[] chars = new char[encoding.GetMaxCharCount(bytes.Length)];
        var frame = new StringBuilder();
        bool partial = false;
        while (true)
        {
            int read = await connection.Pipe.ReadAsync(bytes, connection.Cancellation.Token);
            if (read == 0)
            {
                if (control.Execution is not null)
                {
                    if (!connection.LocallyClosing) control.TransportEnded(connection, TransportClose.RemoteEof);
                    if (partial) connection.Enqueue(Error(null, "invalid_request"));
                    return;
                }
                if (partial) throw new InvalidDataException();
                return;
            }
            int start = 0;
            while (start < read)
            {
                int newline = Array.IndexOf(bytes, (byte)'\n', start, read - start);
                int end = newline < 0 ? read : newline;
                int length = end - start;
                partial |= length != 0;
                int count = decoder.GetChars(bytes, start, length, chars, 0, newline >= 0);
                frame.Append(chars, 0, count);
                if (newline < 0) break;
                if (control.Execution is null)
                    control.HandleRequest(connection, ParseRequest(frame.ToString(), false));
                else
                {
                    try { control.HandleRequest(connection, ParseRequest(frame.ToString(), true)); }
                    catch (Exception error) when (error is JsonException or InvalidDataException or
                        ArgumentException or InvalidOperationException or KeyNotFoundException)
                    {
                        connection.Enqueue(Error(null, "invalid_request"));
                    }
                }
                frame.Clear();
                decoder.Reset();
                partial = false;
                start = end + 1;
            }
        }
    }

    private sealed record Request(string RequestId, string Op, string ExecutionId,
        PreparePayload? Payload = null, JsonElement? Target = null, JsonElement? Descriptor = null,
        string? RequestFingerprint = null, string? Mode = null, long StopRequestedAt = 0, long TerminateAfterAt = 0);

    private static Request ParseRequest(string frame, bool execution)
    {
        using JsonDocument document = execution ? JsonDocument.Parse(frame, new JsonDocumentOptions { MaxDepth = int.MaxValue })
            : JsonDocument.Parse(frame);
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        if (!root.TryGetProperty("op", out JsonElement operation) || operation.ValueKind != JsonValueKind.String)
            throw new InvalidDataException();
        string? operationName = operation.GetString();
        string[] keys = execution && operationName == "prepare"
            ? ["v", "requestId", "op", "executionId", "requestUtf8Base64", "requestFingerprint"]
            : execution && operationName == "request-stop"
                ? ["v", "requestId", "op", "executionId", "target", "descriptor", "requestFingerprint", "mode", "stopRequestedAt", "terminateAfterAt"]
            : execution && operationName == "authorize"
                ? ["v", "requestId", "op", "executionId", "target", "descriptor", "requestFingerprint"]
                : ["v", "requestId", "op", "executionId"];
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in root.EnumerateObject())
            if (!keys.Contains(property.Name, StringComparer.Ordinal) || !names.Add(property.Name))
                throw new InvalidDataException();
        if (names.Count != keys.Length || root.GetProperty("v").ValueKind != JsonValueKind.Number ||
            !root.GetProperty("v").TryGetInt32(out int version) || version != 1 ||
            root.GetProperty("requestId").ValueKind != JsonValueKind.String ||
            root.GetProperty("op").ValueKind != JsonValueKind.String ||
            root.GetProperty("executionId").ValueKind != JsonValueKind.String)
            throw new InvalidDataException();
        string? requestId = root.GetProperty("requestId").GetString();
        string? op = root.GetProperty("op").GetString();
        string? executionId = root.GetProperty("executionId").GetString();
        if (string.IsNullOrEmpty(requestId) ||
            !((op is "claim" or "inspect" or "watch" or "stop") || (execution && (op is "prepare" or "authorize" or "request-stop"))) ||
            executionId is null)
            throw new InvalidDataException();
        if (op == "prepare")
        {
            string carrier = NativeExecutionSession.Text(root, "requestUtf8Base64");
            string fingerprint = NativeExecutionSession.Text(root, "requestFingerprint");
            return new(requestId, op, executionId, PreparePayload.Parse(carrier, fingerprint));
        }
        if (op is "authorize" or "request-stop")
        {
            JsonElement target = root.GetProperty("target"), descriptor = root.GetProperty("descriptor");
            string fingerprint = NativeExecutionSession.Text(root, "requestFingerprint");
            NativeExecutionSession.ValidateAuthorizationShape(target, descriptor, fingerprint);
            if (op == "request-stop")
            {
                string mode = NativeExecutionSession.Text(root, "mode");
                long start = NativeExecutionSession.StopInteger(root.GetProperty("stopRequestedAt")), end = NativeExecutionSession.StopInteger(root.GetProperty("terminateAfterAt"));
                if (mode is not ("soft" or "force") || end <= start) throw new InvalidDataException();
                return new(requestId, op, executionId, Target: target.Clone(), Descriptor: descriptor.Clone(), RequestFingerprint: fingerprint, Mode: mode, StopRequestedAt: start, TerminateAfterAt: end);
            }
            return new(requestId, op, executionId, Target: target.Clone(), Descriptor: descriptor.Clone(), RequestFingerprint: fingerprint);
        }
        return new Request(requestId, op, executionId);
    }

    private static object Error(string? requestId, string code, PrepareDiagnostic? diagnostic = null) =>
        diagnostic is null ? (object)new { v = 1, kind = "error", requestId, code }
            : new { v = 1, kind = "error", requestId, code, prepareDiagnostic = diagnostic };

    private static void Log(string code, string stage) =>
        Console.Error.WriteLine(JsonSerializer.Serialize(new { code, stage }));

    private enum TransportClose { RemoteEof, WriteFailure, LocalShutdown, ProtocolFailure }

    private sealed class ControlSession
    {
        private readonly object gate = new();
        private readonly ControlProcess controller;
        private readonly HashSet<ControlConnection> watchers = [];
        private readonly HashSet<ControlConnection> connections = [];
        private readonly List<Task> connectionTasks = [], operationTasks = [];
        private ControlConnection? owner;
        private string phase = "unclaimed";
        private string? reason;
        private bool shuttingDown;
#if ZEB_NATIVE_TESTS
        private readonly SessionTestBridge? stopAckBridge;
#endif
        internal string ExecutionId { get; } = Guid.NewGuid().ToString("N");
        internal NativeExecutionSession? Execution { get; }
        internal bool ShuttingDown { get { lock (gate) return shuttingDown; } }

        internal ControlSession(ControlProcess controller, ControlProcess current, Bootstrap bootstrap)
        {
            this.controller = controller;
#if ZEB_NATIVE_TESTS
            stopAckBridge = SessionTestBridge.FromStopAckEnvironment(current);
#endif
            if (bootstrap.RecordsRoot is not null)
                Execution = new NativeExecutionSession(gate, ExecutionId, bootstrap.RecordsRoot,
                    bootstrap.InstallationRoot!, bootstrap.ManifestSha256!, current,
                    () => owner is { Active: true } && owner.Client.Pid == controller.Pid &&
                        owner.Client.CreationTime == controller.CreationTime, Broadcast);
        }

        private object Snapshot() => Execution?.Snapshot() ?? new { phase, sealReason = reason };

        private bool Seal(string sealReason)
        {
            if (phase == "sealed") return false;
            phase = "sealed";
            reason = sealReason;
            return true;
        }

        private void Broadcast()
        {
            object message = new { v = 1, kind = "event", @event = "state", executionId = ExecutionId, state = Snapshot() };
            foreach (ControlConnection watcher in watchers) watcher.Enqueue(message);
        }

        internal void ControllerExited()
        {
            lock (gate)
            {
                if (Execution is not null) Execution.Seal("controller_exit");
                else if (Seal("controller_exit")) Broadcast();
            }
        }

        internal void TransportEnded(ControlConnection connection, TransportClose close)
        {
            lock (gate)
            {
                if (!connection.Active || !ReferenceEquals(owner, connection) || Execution is null) return;
                if (close == TransportClose.RemoteEof) Execution.Seal("controller_eof");
                else if (close == TransportClose.WriteFailure) Execution.Seal("control_write_failure");
                else if (close == TransportClose.ProtocolFailure) Execution.EvidenceFailed();
            }
        }

        internal void Closed(ControlConnection connection, TransportClose close = TransportClose.LocalShutdown)
        {
            lock (gate)
            {
                if (!connection.Active) return;
                if (Execution is not null) TransportEnded(connection, close);
                connection.Active = false;
                watchers.Remove(connection);
                connections.Remove(connection);
                if (Execution is null && ReferenceEquals(owner, connection) && Seal("owner_eof")) Broadcast();
            }
        }

        internal void Opened(ControlConnection connection)
        {
            bool closing;
            lock (gate) { connections.Add(connection); closing = shuttingDown; }
            if (closing) connection.Close(TransportClose.LocalShutdown);
        }

        internal void TrackConnection(Task task) { lock (gate) connectionTasks.Add(task); }
        internal void SealRequests() { lock (gate) shuttingDown = true; }
        internal async Task DrainResponsesAsync(CancellationToken deadline)
        {
            Task[] original;
            ControlConnection[] originalConnections;
            lock (gate)
            {
                original = operationTasks.ToArray();
                originalConnections = connections.ToArray();
            }
            await Task.WhenAll(original).WaitAsync(deadline);
            await Task.WhenAll(originalConnections.Select(connection => connection.DrainAsync(deadline))).WaitAsync(deadline);
        }
        internal void BeginShutdown()
        {
            lock (gate) shuttingDown = true;
            CloseConnections();
        }
        internal void CloseConnections()
        {
            ControlConnection[] current;
            lock (gate) current = connections.ToArray();
            foreach (ControlConnection connection in current) connection.Close(TransportClose.LocalShutdown);
        }
        internal Task JoinConnectionsAsync()
        {
            lock (gate) return Task.WhenAll(connectionTasks.ToArray());
        }
        internal async Task JoinOperationsAsync()
        {
            Task[] original;
            lock (gate) original = operationTasks.ToArray();
#if ZEB_NATIVE_TESTS
            try { await Task.WhenAll(original); }
            finally
            {
                try { stopAckBridge?.Dispose(); }
                finally { Execution?.DisposeTestBridge(); }
            }
#else
            await Task.WhenAll(original);
#endif
        }

        private object Response(ControlConnection connection, Request request) => new
        {
            v = 1, kind = "response", requestId = request.RequestId, op = request.Op,
            executionId = ExecutionId, role = ReferenceEquals(owner, connection) ? "owner" : "observer",
            state = Snapshot(),
        };

        private async Task RespondOperationAsync(ControlConnection connection, Request request, Task<SessionOperationResult> operation)
        {
            SessionOperationResult result = await operation;
#if ZEB_NATIVE_TESTS
            if (request.Op == "request-stop" && request.Mode == "soft" && result.ErrorCode is null && stopAckBridge is not null)
            {
                object heldResponse;
                lock (gate)
                {
                    if (!connection.Active || shuttingDown) return;
                    heldResponse = Response(connection, request);
                }
                await Task.Yield(); // HandleRequest's outer gate must be released before the test hold.
                stopAckBridge.Reach("stop", "StopBeforeAck", Execution!, businessRequest: new { request.RequestId, request.Mode, request.StopRequestedAt, request.TerminateAfterAt });
                lock (gate) if (connection.Active && !shuttingDown) connection.Enqueue(heldResponse);
                return;
            }
#endif
            lock (gate)
            {
                if (!connection.Active || (shuttingDown && (request.Op != "prepare" || result.Diagnostic is null))) return;
                connection.Enqueue(result.ErrorCode is null ? Response(connection, request) :
                    Error(request.RequestId, result.ErrorCode, request.Op == "prepare" ? result.Diagnostic : null));
            }
        }

        internal void HandleRequest(ControlConnection connection, Request request)
        {
            lock (gate)
            {
                if (!connection.Active || shuttingDown) return;
                if (!StringComparer.Ordinal.Equals(request.ExecutionId, ExecutionId))
                {
                    connection.Enqueue(Error(request.RequestId, "scope_mismatch"));
                    return;
                }
                string? error = null;
                bool changed = false;
                switch (request.Op)
                {
                    case "claim":
                        if (Execution?.IsSealed ?? phase == "sealed") error = "sealed";
                        else if (connection.Client.Pid != controller.Pid ||
                                 connection.Client.CreationTime != controller.CreationTime)
                            error = "controller_mismatch";
                        else if (owner is not null && !ReferenceEquals(owner, connection))
                            error = "owner_already_claimed";
                        else if (owner is null)
                        {
                            owner = connection;
                            if (Execution is null) phase = "claimed";
                            else Execution.Claimed();
                            changed = true;
                        }
                        break;
                    case "watch":
                        watchers.Add(connection);
                        break;
                    case "stop":
                        if (Execution is null) changed = Seal("stop");
                        else Execution.Seal("stop");
                        break;
                    case "prepare":
                    case "authorize":
                    case "request-stop":
                        if (!ReferenceEquals(owner, connection) || connection.Client.Pid != controller.Pid ||
                            connection.Client.CreationTime != controller.CreationTime) error = "not_owner";
                        else
                        {
                            Task<SessionOperationResult> operation = request.Op == "prepare"
                                ? Execution!.PrepareAsync(request.Payload!)
                                : request.Op == "authorize" ? Execution!.AuthorizeAsync(request.Target!.Value, request.Descriptor!.Value, request.RequestFingerprint!)
                                : Execution!.RequestStopAsync(request.Target!.Value, request.Descriptor!.Value, request.RequestFingerprint!, request.Mode!, request.StopRequestedAt, request.TerminateAfterAt);
                            operationTasks.Add(RespondOperationAsync(connection, request, operation));
                            return;
                        }
                        break;
                }
                if (error is not null) connection.Enqueue(Error(request.RequestId, error));
                else connection.Enqueue(Response(connection, request));
                if (changed) Broadcast();
            }
        }
    }

    private sealed class ControlConnection(NamedPipeServerStream pipe, bool retain,
        ControlProcess client, ControlSession control) : IDisposable
    {
        private readonly Channel<object> output = Channel.CreateUnbounded<object>(new UnboundedChannelOptions
        {
            SingleReader = true, AllowSynchronousContinuations = false,
        });
        private int closed;
        private int localClose;
        internal NamedPipeServerStream Pipe { get; } = pipe;
        internal ControlProcess Client { get; } = client;
        internal CancellationTokenSource Cancellation { get; } = new();
        internal bool Active { get; set; } = true;
        internal bool LocallyClosing => Volatile.Read(ref localClose) != 0 || Cancellation.IsCancellationRequested;
        internal void Enqueue(object message) => output.Writer.TryWrite(message);
        internal Task DrainAsync(CancellationToken deadline)
        {
            var drained = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!output.Writer.TryWrite(drained)) return Task.FromException(new IOException("connection_closed"));
            return drained.Task.WaitAsync(deadline);
        }

        internal async Task WriteAsync()
        {
            try
            {
                await foreach (object message in output.Reader.ReadAllAsync(Cancellation.Token))
                {
                    if (message is TaskCompletionSource<bool> drained)
                    {
                        drained.TrySetResult(true);
                        continue;
                    }
                    byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(message);
                    Array.Resize(ref bytes, bytes.Length + 1);
                    bytes[^1] = (byte)'\n';
                    await Pipe.WriteAsync(bytes, Cancellation.Token);
                }
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException)
            {
                if (control.Execution is not null && !LocallyClosing)
                    control.TransportEnded(this, error is IOException ? TransportClose.WriteFailure : TransportClose.ProtocolFailure);
            }
            catch
            {
                if (control.Execution is not null && !LocallyClosing)
                    control.TransportEnded(this, TransportClose.ProtocolFailure);
                Log("connection_closed", "write");
            }
            finally { Close(); }
        }

        internal void Close(TransportClose reason = TransportClose.LocalShutdown)
        {
            if (reason == TransportClose.LocalShutdown) Interlocked.Exchange(ref localClose, 1);
            if (Interlocked.Exchange(ref closed, 1) != 0) return;
            control.Closed(this, reason);
            output.Writer.TryComplete();
            Cancellation.Cancel();
            // The retained accept loop disconnects after both old I/O loops have joined.
            if (!retain && control.Execution is null) Pipe.Dispose();
        }

        public void Dispose()
        {
            Close();
            Cancellation.Dispose();
            if (!retain && control.Execution is not null) Pipe.Dispose();
        }
    }
}
