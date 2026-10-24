using System.ComponentModel;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

[assembly: SupportedOSPlatform("windows")]

namespace Zeb.WindowsSupervisor;

public sealed record ProcessIdentity(int Pid, ulong CreationFileTime);

internal sealed record EngineRuntimeToken(uint Pid, ulong CreationFileTime, string UserSid, uint SessionId)
{
    internal object Wire => new { pid = Pid,
        creationFileTime = CreationFileTime.ToString(System.Globalization.CultureInfo.InvariantCulture),
        userSid = UserSid, sessionId = SessionId };
}

public sealed record ProcessRootExit(ProcessIdentity Identity, uint ExitCode);

// Native process/Job proof only. The caller separately joins both real stream drains.
public sealed record JobTreeExit(uint EngineExitCode, uint ActiveProcesses);

public sealed record JobProcessObservation(
    ProcessIdentity EngineIdentity, bool ProcessSignaled, bool InOriginalJob,
    uint ActiveProcesses, uint TotalProcesses,
    uint JobHandleFlags, uint ProcessHandleFlags, bool Authorized, bool Sealed);

public sealed class JobPreparationException(string stage, int nativeErrorCode)
    : Win32Exception(nativeErrorCode, $"Native prepare failed at {stage}.")
{
    public string Stage { get; } = stage;
}

#if ZEB_NATIVE_TESTS
public enum PrepareFailurePoint { InvalidJobHandle, AttributeSetup }
#endif

public sealed class JobProcess : IDisposable
{
    private const int JobFullControl = 0x001f003f;
    private readonly object sync = new();
    private readonly object disposeSync = new();
    private readonly KernelHandle job, port, process, primaryThread;
    private readonly SecurityIdentifier user;
    private readonly FileStream input, output, error;
    private readonly EventWaitHandle stop;
    private readonly AutoResetEvent membersChanged;
    private readonly ProcessWait engineWait;
    private readonly MemberPin initialMember;
    private readonly Thread monitor;
    private readonly TaskCompletionSource<ProcessRootExit> rootExit = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<JobTreeExit> terminal = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Exception? monitorCleanupError;
    private bool authorized, sealedExecution, disposed;

    private JobProcess(KernelHandle job, KernelHandle port, KernelHandle process, KernelHandle primaryThread,
        FileStream input, FileStream output, FileStream error, EventWaitHandle stop, AutoResetEvent membersChanged,
        ProcessWait engineWait, MemberPin initialMember,
        ProcessIdentity engineIdentity, string jobName, SecurityIdentifier user)
    {
        this.job = job;
        this.port = port;
        this.process = process;
        this.primaryThread = primaryThread;
        this.user = user;
        this.input = input;
        this.output = output;
        this.error = error;
        this.stop = stop;
        this.membersChanged = membersChanged;
        this.engineWait = engineWait;
        this.initialMember = initialMember;
        EngineIdentity = engineIdentity;
        JobName = jobName;
        monitor = new Thread(MonitorTree) { IsBackground = true, Name = "Zeb-Job-monitor" };
    }

    public static JobProcess Prepare(string executable, IReadOnlyList<string> argv, string workingDirectory)
        => PrepareCore(executable, argv, workingDirectory);

#if ZEB_NATIVE_TESTS
    public static JobProcess PrepareForTest(
        string executable, IReadOnlyList<string> argv, string workingDirectory, PrepareFailurePoint failurePoint)
        => PrepareCore(executable, argv, workingDirectory, failurePoint);
#endif

    private static JobProcess PrepareCore(string executable, IReadOnlyList<string> argv, string workingDirectory
#if ZEB_NATIVE_TESTS
        , PrepareFailurePoint? failurePoint = null
#endif
    )
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows Job primitives require Windows.");
        ArgumentException.ThrowIfNullOrEmpty(executable);
        ArgumentNullException.ThrowIfNull(argv);
        ArgumentException.ThrowIfNullOrEmpty(workingDirectory);
        executable = Path.GetFullPath(executable);
        workingDirectory = Path.GetFullPath(workingDirectory);
        var commandLine = new StringBuilder(Quote(executable));
        foreach (var argument in argv)
        {
            ArgumentNullException.ThrowIfNull(argument);
            if (argument.Contains('\0')) throw new ArgumentException("Windows command-line arguments cannot contain NUL.", nameof(argv));
            commandLine.Append(' ').Append(Quote(argument));
        }

        var owned = new List<IDisposable>();
        T Own<T>(T resource) where T : IDisposable { owned.Add(resource); return resource; }
        KernelHandle? engine = null;
        KernelHandle? originalJob = null;
        Exception? preparationError = null;
        try
        {
            SecurityIdentifier user;
            using (var identity = WindowsIdentity.GetCurrent())
                user = identity.User ?? throw new InvalidOperationException("Current Windows user is unavailable.");
            var jobName = @"Local\Zeb-" + Guid.NewGuid().ToString("N");
            var acl = new RawAcl(GenericAcl.AclRevision, 1);
            acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, JobFullControl, user, false, null));
            var descriptor = new RawSecurityDescriptor(ControlFlags.SelfRelative | ControlFlags.DiscretionaryAclPresent |
                ControlFlags.DiscretionaryAclProtected, user, null, null, acl);
            var binary = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(binary, 0);
            var pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
            int createJobError;
            try
            {
                var security = new NativeMethods.SecurityAttributes
                {
                    Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(),
                    SecurityDescriptor = pinned.AddrOfPinnedObject(), InheritHandle = false
                };
                originalJob = NativeMethods.CreateJobObjectW(ref security, jobName);
                createJobError = Marshal.GetLastWin32Error();
                Own(originalJob);
            }
            finally { pinned.Free(); }
            if (originalJob.IsInvalid || createJobError == NativeMethods.ErrorAlreadyExists)
                throw new JobPreparationException("CreateJobObjectW", createJobError);
            VerifyNotInherited(originalJob);
            VerifyJobSecurity(originalJob, user);
            var limits = new NativeMethods.ExtendedLimitInformation
            {
                BasicLimitInformation = new NativeMethods.BasicLimitInformation { LimitFlags = NativeMethods.JobObjectLimitKillOnJobClose }
            };
            NativeMethods.CheckPreparation(NativeMethods.SetJobLimits(originalJob, NativeMethods.JobObjectExtendedLimitInformation,
                ref limits, (uint)Marshal.SizeOf<NativeMethods.ExtendedLimitInformation>()), "SetInformationJobObject(limits)");

            var completionPort = Own(NativeMethods.CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1));
            NativeMethods.CheckPreparation(!completionPort.IsInvalid, "CreateIoCompletionPort");
            VerifyNotInherited(completionPort);
            var association = new NativeMethods.CompletionPortAssociation
            {
                CompletionKey = NativeMethods.JobCompletionKey,
                CompletionPort = completionPort.DangerousGetHandle()
            };
            NativeMethods.CheckPreparation(NativeMethods.AssociateCompletionPort(originalJob, NativeMethods.JobObjectAssociateCompletionPortInformation,
                ref association, (uint)Marshal.SizeOf<NativeMethods.CompletionPortAssociation>()), "SetInformationJobObject(completion-port)");

            var stdin = CreatePipe(childReads: true);
            Own(stdin.Parent);
            Own(stdin.Child);
            var stdout = CreatePipe(childReads: false);
            Own(stdout.Parent);
            Own(stdout.Child);
            var stderr = CreatePipe(childReads: false);
            Own(stderr.Parent);
            Own(stderr.Child);
            var attributes = Own(new AttributeList());
            var jobHandle = originalJob.DangerousGetHandle();
            var jobListSize = (UIntPtr)(uint)IntPtr.Size;
#if ZEB_NATIVE_TESTS
            if (failurePoint == PrepareFailurePoint.AttributeSetup) jobListSize = (UIntPtr)(uint)(IntPtr.Size - 1);
            if (failurePoint == PrepareFailurePoint.InvalidJobHandle) originalJob.Dispose();
#endif
            attributes.SetHandles(NativeMethods.ProcThreadAttributeJobList, [jobHandle], jobListSize);
            attributes.SetHandles(NativeMethods.ProcThreadAttributeHandleList,
                [stdin.Child.DangerousGetHandle(), stdout.Child.DangerousGetHandle(), stderr.Child.DangerousGetHandle()], (UIntPtr)(uint)(3 * IntPtr.Size));
            var startup = new NativeMethods.StartupInfoEx
            {
                StartupInfo = new NativeMethods.StartupInfo
                {
                    Cb = (uint)Marshal.SizeOf<NativeMethods.StartupInfoEx>(),
                    Flags = NativeMethods.StartfUseStdHandles,
                    StandardInput = stdin.Child.DangerousGetHandle(),
                    StandardOutput = stdout.Child.DangerousGetHandle(),
                    StandardError = stderr.Child.DangerousGetHandle()
                },
                AttributeList = attributes.Pointer
            };
            NativeMethods.CheckPreparation(NativeMethods.CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                NativeMethods.CreateSuspended | NativeMethods.ExtendedStartupInfoPresent | NativeMethods.CreateNoWindow,
                IntPtr.Zero, workingDirectory, ref startup, out var created), "CreateProcessW");
            engine = Own(new KernelHandle(created.Process));
            var thread = Own(new KernelHandle(created.Thread));
            VerifyNotInherited(engine);
            VerifyNotInherited(thread);
            NativeMethods.CheckPreparation(NativeMethods.IsProcessInJob(engine, originalJob, out var belongs), "IsProcessInJob");
            if (!belongs) throw new InvalidOperationException("Created suspended engine is outside its original Job.");
            NativeMethods.CheckPreparation(NativeMethods.GetProcessTimes(engine, out var creation, out _, out _, out _), "GetProcessTimes");
            var enginePid = NativeMethods.GetProcessId(engine);
            NativeMethods.CheckPreparation(enginePid != 0, "GetProcessId");
            if (enginePid != created.ProcessId || creation <= 0) throw new InvalidOperationException("Original engine identity is inconsistent.");
            NativeMethods.CheckPreparation(NativeMethods.QueryInformationJobObject(originalJob, NativeMethods.JobObjectBasicAccountingInformation,
                out var accounting, (uint)Marshal.SizeOf<NativeMethods.BasicAccountingInformation>(), IntPtr.Zero), "QueryInformationJobObject");
            if (accounting.ActiveProcesses != 1 || accounting.TotalProcesses != 1)
                throw new InvalidOperationException("Fresh prepared Job does not contain exactly its original engine.");
            VerifySuspendedEngineLive(engine);

            var input = Own(new FileStream(stdin.Parent, FileAccess.Write));
            var output = Own(new FileStream(stdout.Parent, FileAccess.Read));
            var error = Own(new FileStream(stderr.Parent, FileAccess.Read));
            var stop = Own(new EventWaitHandle(false, EventResetMode.ManualReset));
            var membersChanged = Own(new AutoResetEvent(false));
            var engineWait = Own(new ProcessWait(engine));
            var engineIdentity = new ProcessIdentity(checked((int)enginePid), unchecked((ulong)creation));
            // Register the original suspended engine's actual exit before Prepare can return or authorize.
            var initialMember = Own(new MemberPin(engine, engineIdentity, membersChanged, ownsProcess: false));
            stdin.Child.Dispose();
            stdout.Child.Dispose();
            stderr.Child.Dispose();
            attributes.Dispose();
            VerifySuspendedEngineLive(engine);
            var result = new JobProcess(originalJob, completionPort, engine, thread, input, output, error, stop, membersChanged,
                engineWait, initialMember, engineIdentity, jobName, user);
            result.monitor.Start();
            owned.Clear();
            return result;
        }
        catch (Exception caught)
        {
            preparationError = caught;
            // No application thread has been authorized. Only this exact created process can be terminated here.
            if (engine is not null && !engine.IsInvalid && !engine.IsClosed)
            {
                try
                {
                    if (NativeMethods.WaitForSingleObject(engine, 0) != NativeMethods.WaitObject0 &&
                        !NativeMethods.TerminateProcess(engine, NativeMethods.ForcedExitCode))
                        originalJob?.Dispose(); // Kill-on-close still contains a successful create.
                    var joined = NativeMethods.WaitForSingleObject(engine, NativeMethods.Infinite);
                    NativeMethods.Check(joined == NativeMethods.WaitObject0, "WaitForSingleObject(prepare cleanup)");
                }
                catch (Exception cleanupError) { caught.Data["NativeCleanupError"] = cleanupError; }
            }
            throw;
        }
        finally
        {
            Exception? closeError = null;
            for (var index = owned.Count - 1; index >= 0; --index)
            {
                try { owned[index].Dispose(); }
                catch (Exception closeFailure) { closeError ??= closeFailure; }
            }
            if (closeError is not null)
            {
                if (preparationError is not null) preparationError.Data["NativeCloseError"] = closeError;
                else ExceptionDispatchInfo.Capture(closeError).Throw();
            }
        }
    }

    public ProcessIdentity EngineIdentity { get; }
    public string JobName { get; }
    public bool IsPrepared { get { lock (sync) return !disposed && !authorized && !sealedExecution; } }
    public bool IsSealed { get { lock (sync) return sealedExecution; } }
    public Stream StandardInput { get { lock (sync) { ObjectDisposedException.ThrowIf(disposed, this); return input; } } }
    public Stream StandardOutput { get { lock (sync) { ObjectDisposedException.ThrowIf(disposed, this); return output; } } }
    public Stream StandardError { get { lock (sync) { ObjectDisposedException.ThrowIf(disposed, this); return error; } } }

    public JobProcessObservation Inspect()
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            NativeMethods.Check(NativeMethods.GetProcessTimes(process, out var creation, out _, out _, out _), "GetProcessTimes(original engine)");
            var pid = NativeMethods.GetProcessId(process);
            NativeMethods.Check(pid != 0, "GetProcessId(original engine)");
            var identity = new ProcessIdentity(checked((int)pid), unchecked((ulong)creation));
            if (creation <= 0 || identity != EngineIdentity) throw new InvalidOperationException("Original engine identity is inconsistent.");
            NativeMethods.Check(NativeMethods.IsProcessInJob(process, job, out var belongs), "IsProcessInJob(original engine)");
            NativeMethods.Check(NativeMethods.QueryInformationJobObject(job, NativeMethods.JobObjectBasicAccountingInformation,
                out var accounting, (uint)Marshal.SizeOf<NativeMethods.BasicAccountingInformation>(), IntPtr.Zero), "QueryInformationJobObject");
            var jobFlags = VerifyNotInherited(job);
            var processFlags = VerifyNotInherited(process);
            VerifyJobSecurity(job, user);
            // sync protects this object's lifetime and state, not an atomic snapshot across native queries.
            return new JobProcessObservation(identity, Signaled(process), belongs, accounting.ActiveProcesses, accounting.TotalProcesses,
                jobFlags, processFlags, authorized, sealedExecution);
        }
    }

    internal EngineRuntimeToken ReadRuntimeToken()
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            void RequireOriginal()
            {
                NativeMethods.Check(NativeMethods.GetProcessTimes(process, out long created, out _, out _, out _), "GetProcessTimes(observation)");
                if (NativeMethods.GetProcessId(process) != (uint)EngineIdentity.Pid ||
                    unchecked((ulong)created) != EngineIdentity.CreationFileTime || Signaled(process))
                    throw new InvalidDataException();
            }
            RequireOriginal();
            NativeMethods.Check(NativeMethods.OpenProcessToken(process, 8, out KernelHandle token), "OpenProcessToken(observation)");
            using (token)
            {
                VerifyNotInherited(token);
                if (NativeMethods.GetTokenInformation(token, 1, IntPtr.Zero, 0, out uint length) ||
                    Marshal.GetLastWin32Error() != NativeMethods.ErrorInsufficientBuffer || length < IntPtr.Size)
                    throw new InvalidDataException();
                IntPtr bytes = Marshal.AllocHGlobal(checked((int)length));
                try
                {
                    NativeMethods.Check(NativeMethods.GetTokenInformation(token, 1, bytes, length, out uint returned), "GetTokenInformation(user)");
                    if (returned > length || returned < IntPtr.Size) throw new InvalidDataException();
                    string sid = new SecurityIdentifier(Marshal.ReadIntPtr(bytes)).Value;
                    NativeMethods.Check(NativeMethods.GetTokenInformation(token, 12, bytes, sizeof(uint), out returned), "GetTokenInformation(session)");
                    if (returned != sizeof(uint)) throw new InvalidDataException();
                    uint session = unchecked((uint)Marshal.ReadInt32(bytes));
                    RequireOriginal();
                    return new((uint)EngineIdentity.Pid, EngineIdentity.CreationFileTime, sid, session);
                }
                finally { Marshal.FreeHGlobal(bytes); }
            }
        }
    }

    public bool AuthorizeOnce()
    {
        lock (disposeSync)
        {
            bool resumed = TryResumeOnceRetainingResources(out Exception? failure);
            if (failure is null) return resumed;
            var closedForCleanup = false;
            lock (sync)
            {
                // Never attempt a second resume, including when the native suspend count was unexpected.
                if (!NativeMethods.TerminateJobObject(job, NativeMethods.ForcedExitCode))
                {
                    failure.Data["NativeCleanupError"] = new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject(authorize cleanup) failed.");
                    job.Dispose();
                    closedForCleanup = true;
                }
            }
            try
            {
                if (closedForCleanup)
                    NativeMethods.Check(NativeMethods.WaitForSingleObject(process, NativeMethods.Infinite) == NativeMethods.WaitObject0, "WaitForSingleObject(authorize cleanup)");
                else WaitForTreeExitAsync().GetAwaiter().GetResult();
            }
            catch (Exception cleanupError) { failure.Data["NativeJoinError"] = cleanupError; }
            finally
            {
                try { Dispose(); }
                catch (Exception closeError) { failure.Data["NativeCloseError"] = closeError; }
            }
            ExceptionDispatchInfo.Capture(failure).Throw();
            return false;
        }
    }

    internal bool TryResumeOnceRetainingResources(out Exception? failure)
    {
        lock (sync)
        {
            failure = null;
            if (disposed || sealedExecution || authorized) return false;
            uint previousCount = NativeMethods.ResumeThread(primaryThread);
            if (previousCount == 1)
            {
                authorized = true;
                primaryThread.Dispose();
                return true;
            }
            failure = previousCount == uint.MaxValue
                ? new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed.")
                : new InvalidOperationException("Primary thread did not have the expected single prepare suspension.");
            sealedExecution = true;
            return false;
        }
    }

#if ZEB_NATIVE_TESTS
    internal uint AddPrimarySuspensionForTest()
    {
        lock (sync)
        {
            if (disposed || sealedExecution || authorized) throw new InvalidOperationException();
            uint previous = SuspendThread(primaryThread);
            if (previous == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (previous != 1) throw new InvalidOperationException();
            return previous;
        }
    }

    internal void ForceQueryOnlyForTest()
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            sealedExecution = true;
            bool copied = DuplicateJobHandle(new IntPtr(-1), job, new IntPtr(-1), out KernelHandle query,
                0x0004, false, 0);
            int nativeError = Marshal.GetLastWin32Error();
            using (query)
            {
                if (!copied) throw new Win32Exception(nativeError);
                VerifyNotInherited(query);
                NativeMethods.Check(NativeMethods.TerminateJobObject(query, NativeMethods.ForcedExitCode), "TerminateJobObject(query-only test handle)");
                throw new InvalidOperationException("Query-only test handle unexpectedly allowed termination.");
            }
        }
    }

    internal void CloseOriginalJobForTest()
    {
        lock (sync) job.Dispose();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SuspendThread(KernelHandle thread);
    [DllImport("kernel32.dll", EntryPoint = "DuplicateHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateJobHandle(IntPtr sourceProcess, KernelHandle source, IntPtr targetProcess,
        out KernelHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
#endif

    public void Seal() { lock (sync) sealedExecution = true; }

    public void Force()
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            sealedExecution = true;
            NativeMethods.Check(NativeMethods.TerminateJobObject(job, NativeMethods.ForcedExitCode), "TerminateJobObject");
        }
    }

    public Task<ProcessRootExit> WaitForProcessExitAsync(CancellationToken cancellationToken = default)
        => rootExit.Task.WaitAsync(cancellationToken);

    public Task<JobTreeExit> WaitForTreeExitAsync(CancellationToken cancellationToken = default)
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return terminal.Task.WaitAsync(cancellationToken);
        }
    }

    private void MonitorTree()
    {
        var members = new Dictionary<uint, MemberPin> { [checked((uint)EngineIdentity.Pid)] = initialMember };
        try
        {
            while (true)
            {
                // Completed original Job messages are advisory. Real pinned process exits drive every
                // refresh, including discovery of descendants whose Job notification was never delivered.
                DrainJobMessages();
                foreach (var pair in members.ToArray())
                {
                    if (!pair.Value.Signaled) continue;
                    if (ReferenceEquals(pair.Value, initialMember))
                    {
                        lock (sync)
                        {
                            if (disposed) return;
                            // Publish before unregistering the original root's last reliable exit wakeup.
                            ObserveRootExit();
                        }
                    }
                    pair.Value.Dispose();
                    members.Remove(pair.Key);
                }
                var racedExit = false;
                foreach (var pid in SnapshotMemberIds())
                {
                    if (members.ContainsKey(pid)) continue;
                    var member = OpenMember(pid);
                    if (member is null) { racedExit = true; continue; }
                    try { members.Add(pid, member); }
                    catch { member.Dispose(); throw; }
                }
                uint active;
                lock (sync)
                {
                    if (disposed) return;
                    active = ActiveProcesses();
                }
                if (active == 0)
                {
                    // Empty accounting alone cannot replace the independent original engine signal.
                    if (WaitHandle.WaitAny([engineWait, stop]) != 0) return;
                    lock (sync)
                    {
                        if (disposed) return;
                        var exitCode = ObserveRootExit();
                        active = ActiveProcesses();
                        if (active != 0) continue;
                        terminal.TrySetResult(new JobTreeExit(exitCode, active));
                        return;
                    }
                }
                // A disappearance or signal during snapshot/open is a real native race, so refresh
                // immediately. Otherwise at least one exact live member owns a reliable exit wakeup.
                if (racedExit || members.Count == 0 || members.Values.Any(member => member.Signaled)) continue;
                if (WaitHandle.WaitAny([membersChanged, stop]) != 0) return;
            }
        }
        catch (Exception monitorError)
        {
            lock (sync)
            {
                if (!disposed)
                {
                    rootExit.TrySetException(monitorError);
                    terminal.TrySetException(monitorError);
                }
            }
        }
        finally
        {
            foreach (var member in members.Values)
            {
                try { member.Dispose(); }
                catch (Exception cleanupError) { monitorCleanupError ??= cleanupError; }
            }
            if (monitorCleanupError is not null)
            {
                lock (sync)
                {
                    if (!disposed)
                    {
                        rootExit.TrySetException(monitorCleanupError);
                        terminal.TrySetException(monitorCleanupError);
                    }
                }
            }
        }
    }

    private uint ObserveRootExit()
    {
        if (!Signaled(process)) throw new InvalidOperationException("Original engine wait disagrees with its native handle.");
        NativeMethods.Check(NativeMethods.GetExitCodeProcess(process, out var exitCode), "GetExitCodeProcess");
        rootExit.TrySetResult(new ProcessRootExit(EngineIdentity, exitCode));
        return exitCode;
    }

    private void DrainJobMessages()
    {
        while (true)
        {
            bool received;
            UIntPtr key;
            int nativeError;
            lock (sync)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                received = NativeMethods.GetQueuedCompletionStatus(port.DangerousGetHandle(), out _, out key, out _, 0);
                nativeError = Marshal.GetLastWin32Error();
            }
            if (!received)
            {
                if (nativeError != NativeMethods.WaitTimeout) throw new Win32Exception(nativeError, "GetQueuedCompletionStatus failed.");
                return;
            }
            if (key != NativeMethods.JobCompletionKey) throw new InvalidOperationException("Unexpected original Job completion key.");
        }
    }

    private uint[] SnapshotMemberIds()
    {
        const int headerSize = 2 * sizeof(uint); // JOBOBJECT_BASIC_PROCESS_ID_LIST's two DWORD fields.
        uint capacity = 1; // The native ABI declares ProcessIdList[1], not a header-only structure.
        while (true)
        {
            var byteLength = checked(headerSize + checked((int)capacity) * IntPtr.Size);
            var buffer = Marshal.AllocHGlobal(byteLength);
            try
            {
                bool queried;
                int nativeError;
                uint returnedLength;
                lock (sync)
                {
                    ObjectDisposedException.ThrowIf(disposed, this);
                    queried = NativeMethods.QueryJobProcessIds(job, 3, buffer, (uint)byteLength, out returnedLength);
                    nativeError = Marshal.GetLastWin32Error();
                }
                if (!queried && nativeError != NativeMethods.ErrorMoreData)
                    throw new Win32Exception(nativeError, "QueryInformationJobObject(process IDs) failed.");
                var assigned = unchecked((uint)Marshal.ReadInt32(buffer));
                var listed = unchecked((uint)Marshal.ReadInt32(buffer, sizeof(uint)));
                if (!queried || assigned > listed)
                {
                    var required = assigned;
                    if (returnedLength > headerSize)
                        required = Math.Max(required, checked((returnedLength - headerSize + (uint)IntPtr.Size - 1) / (uint)IntPtr.Size));
                    if (required <= capacity)
                    {
                        lock (sync)
                        {
                            ObjectDisposedException.ThrowIf(disposed, this);
                            var current = ActiveProcesses();
                            if (current == assigned)
                            {
                                if (!queried) throw new Win32Exception(nativeError, "Original Job process-list sizing did not supply a usable native size.");
                                throw new InvalidOperationException("Original Job process-list sizing returned an incomplete stable snapshot.");
                            }
                            required = current;
                        }
                    }
                    capacity = Math.Max(1u, required); // Preserve ProcessIdList[1] even when a native race reaches zero.
                    continue;
                }
                if (listed > capacity || assigned != listed) throw new InvalidOperationException("Original Job returned an inconsistent process-list size.");
                var ids = new uint[checked((int)listed)];
                for (var index = 0; index < ids.Length; ++index)
                {
                    var value = unchecked((ulong)Marshal.ReadIntPtr(buffer, checked(headerSize + index * IntPtr.Size)).ToInt64());
                    if (value == 0 || value > uint.MaxValue) throw new InvalidOperationException("Original Job returned an invalid process ID.");
                    ids[index] = (uint)value;
                }
                if (ids.Distinct().Count() != ids.Length) throw new InvalidOperationException("Original Job returned duplicate member IDs.");
                return ids;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    private MemberPin? OpenMember(uint pid)
    {
        var handle = NativeMethods.OpenProcess(NativeMethods.QueryProcessAndSynchronize, false, pid);
        var openError = Marshal.GetLastWin32Error();
        try
        {
            if (handle.IsInvalid)
            {
                if (openError == NativeMethods.ErrorInvalidParameter && !SnapshotMemberIds().Contains(pid))
                    return null; // A fresh original Job snapshot proves this PID disappeared after the earlier snapshot.
                throw new Win32Exception(openError, "OpenProcess(original Job member) failed.");
            }
            VerifyNotInherited(handle);
            NativeMethods.Check(NativeMethods.GetProcessTimes(handle, out var creation, out _, out _, out _), "GetProcessTimes(original Job member)");
            var actualPid = NativeMethods.GetProcessId(handle);
            NativeMethods.Check(actualPid != 0, "GetProcessId(original Job member)");
            if (actualPid != pid || creation <= 0) throw new InvalidOperationException("Original Job member identity could not be verified.");
            bool belongs;
            lock (sync)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                NativeMethods.Check(NativeMethods.IsProcessInJob(handle, job, out belongs), "IsProcessInJob(original Job member)");
            }
            if (!belongs)
            {
                if (!SnapshotMemberIds().Contains(pid)) return null; // Never adopt an exited/reused PID outside the current original Job.
                throw new InvalidOperationException("An open live snapshot process is outside the original Job.");
            }
            var identity = new ProcessIdentity(checked((int)actualPid), unchecked((ulong)creation));
            if (pid == (uint)EngineIdentity.Pid && identity != EngineIdentity)
                throw new InvalidOperationException("Original engine identity changed during a Job snapshot.");
            var member = new MemberPin(handle, identity, membersChanged, ownsProcess: true);
            handle = null!; // Ownership transfers only after wait registration succeeds.
            return member;
        }
        finally { handle?.Dispose(); }
    }

    private uint ActiveProcesses()
    {
        NativeMethods.Check(NativeMethods.QueryInformationJobObject(job, NativeMethods.JobObjectBasicAccountingInformation,
            out var accounting, (uint)Marshal.SizeOf<NativeMethods.BasicAccountingInformation>(), IntPtr.Zero), "QueryInformationJobObject");
        return accounting.ActiveProcesses;
    }

    public void Dispose()
    {
        lock (disposeSync)
        {
            Exception? closeError = null;
            void Close(IDisposable resource)
            {
                try { resource.Dispose(); }
                catch (Exception failure) { closeError ??= failure; }
            }
            lock (sync)
            {
                if (disposed) return;
                disposed = true;
                sealedExecution = true;
                rootExit.TrySetException(new ObjectDisposedException(nameof(JobProcess)));
                terminal.TrySetException(new ObjectDisposedException(nameof(JobProcess)));
                // Do not call TerminateJobObject: last-owner close is itself the containment mechanism.
                Close(job);
                try { stop.Set(); }
                catch (Exception failure) { closeError ??= failure; }
            }
            monitor.Join();
            closeError ??= monitorCleanupError;
            Close(engineWait);
            Close(membersChanged);
            Close(stop);
            Close(primaryThread);
            Close(input);
            Close(output);
            Close(error);
            Close(process);
            Close(port);
            if (closeError is not null) ExceptionDispatchInfo.Capture(closeError).Throw();
        }
    }

    private static uint VerifyNotInherited(SafeHandle handle)
    {
        NativeMethods.CheckPreparation(NativeMethods.GetHandleInformation(handle, out var flags), "GetHandleInformation");
        if ((flags & NativeMethods.HandleFlagInherit) != 0) throw new InvalidOperationException("An owning handle is unexpectedly inheritable.");
        return flags;
    }

    private static void VerifyJobSecurity(KernelHandle job, SecurityIdentifier user)
    {
        var nativeError = NativeMethods.GetSecurityInfo(job, ResourceType.KernelObject, 5,
            out _, out _, out _, out _, out var descriptor);
        if (nativeError != 0) throw new Win32Exception(unchecked((int)nativeError), "GetSecurityInfo(original Job) failed.");
        try
        {
            if (descriptor == IntPtr.Zero) throw new InvalidOperationException("Original Job security is inconsistent.");
            var length = NativeMethods.GetSecurityDescriptorLength(descriptor);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorLength(original Job) failed.");
            var binary = new byte[checked((int)length)];
            Marshal.Copy(descriptor, binary, 0, binary.Length);
            RawSecurityDescriptor actual;
            try { actual = new RawSecurityDescriptor(binary, 0); }
            catch (ArgumentException) { throw new InvalidOperationException("Original Job security is inconsistent."); }
            const ControlFlags required = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected;
            if (actual.Owner is not { } owner || !user.Equals(owner) || (actual.ControlFlags & required) != required ||
                actual.DiscretionaryAcl is not { Count: 1 } dacl || dacl[0] is not CommonAce ace ||
                ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None || ace.IsCallback || ace.OpaqueLength != 0 ||
                ace.AccessMask != JobFullControl || !user.Equals(ace.SecurityIdentifier))
                throw new InvalidOperationException("Original Job security is inconsistent.");
        }
        finally { if (descriptor != IntPtr.Zero) NativeMethods.LocalFree(descriptor); }
    }

    private static void VerifySuspendedEngineLive(KernelHandle engine)
    {
        var wait = NativeMethods.WaitForSingleObject(engine, 0);
        if (wait == NativeMethods.WaitTimeout) return;
        if (wait == uint.MaxValue) throw new JobPreparationException("WaitForSingleObject", Marshal.GetLastWin32Error());
        throw new InvalidOperationException("Prepared engine exited before authorization.");
    }

    private static (SafeFileHandle Parent, SafeFileHandle Child) CreatePipe(bool childReads)
    {
        var security = new NativeMethods.SecurityAttributes { Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(), InheritHandle = true };
        var created = NativeMethods.CreatePipe(out var read, out var write, ref security, 0);
        var nativeError = Marshal.GetLastWin32Error();
        try
        {
            if (!created) throw new JobPreparationException("CreatePipe", nativeError);
            var parent = childReads ? write : read;
            NativeMethods.CheckPreparation(NativeMethods.SetHandleInformation(parent, NativeMethods.HandleFlagInherit, 0), "SetHandleInformation");
            VerifyNotInherited(parent);
            return (parent, childReads ? read : write);
        }
        catch { read.Dispose(); write.Dispose(); throw; }
    }

    // CreateProcessW receives a mutable literal command line; no command interpreter participates.
    private static string Quote(string argument)
    {
        var quoted = new StringBuilder("\"");
        var slashes = 0;
        foreach (var value in argument)
        {
            if (value == '\\') { ++slashes; continue; }
            quoted.Append('\\', value == '"' ? checked(slashes * 2 + 1) : slashes);
            quoted.Append(value);
            slashes = 0;
        }
        quoted.Append('\\', checked(slashes * 2)).Append('"');
        return quoted.ToString();
    }

    private sealed class ProcessWait : WaitHandle
    {
        internal ProcessWait(KernelHandle process)
        {
            var duplicated = NativeMethods.DuplicateHandle(new IntPtr(-1), process, new IntPtr(-1), out var duplicate,
                0, false, NativeMethods.DuplicateSameAccess);
            var nativeError = Marshal.GetLastWin32Error();
            if (!duplicated)
            {
                duplicate.Dispose();
                throw new Win32Exception(nativeError, "DuplicateHandle(process wait) failed.");
            }
            SafeWaitHandle = duplicate;
        }
    }

    private static bool Signaled(KernelHandle process)
    {
        var waited = NativeMethods.WaitForSingleObject(process, 0);
        if (waited == NativeMethods.WaitObject0) return true;
        if (waited == NativeMethods.WaitTimeout) return false;
        if (waited == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject(member) failed.");
        throw new InvalidOperationException("Unexpected original Job member wait result.");
    }

    private sealed class MemberPin : IDisposable
    {
        private readonly object callbackSync = new();
        private readonly KernelHandle process;
        private readonly ProcessWait wait;
        private readonly RegisteredWaitHandle registration;
        private readonly AutoResetEvent changed;
        private readonly bool ownsProcess;
        private bool stopped;
        internal ProcessIdentity Identity { get; }
        internal bool Signaled => JobProcess.Signaled(process);

        internal MemberPin(KernelHandle process, ProcessIdentity identity, AutoResetEvent changed, bool ownsProcess)
        {
            this.process = process;
            this.changed = changed;
            this.ownsProcess = ownsProcess;
            Identity = identity;
            wait = new ProcessWait(process);
            try
            {
                registration = ThreadPool.RegisterWaitForSingleObject(wait, (_, _) =>
                {
                    lock (callbackSync)
                    {
                        if (!stopped) this.changed.Set();
                    }
                }, null, Timeout.Infinite, executeOnlyOnce: true);
            }
            catch { wait.Dispose(); throw; }
        }

        public void Dispose()
        {
            lock (callbackSync)
            {
                if (stopped) return;
                stopped = true;
            }
            // Never hold callbackSync while joining a callback which may need that lock.
            try
            {
                using var callbacksDone = new ManualResetEvent(false);
                if (registration.Unregister(callbacksDone)) callbacksDone.WaitOne();
            }
            finally
            {
                // The duplicated SafeWaitHandle also remains safe under any outstanding BCL wait reference.
                wait.Dispose();
                if (ownsProcess) process.Dispose();
            }
        }
    }

    private sealed class AttributeList : IDisposable
    {
        internal IntPtr Pointer { get; private set; }
        private readonly List<IntPtr> values = [];

        internal AttributeList()
        {
            var size = UIntPtr.Zero;
            var measured = NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            var nativeError = Marshal.GetLastWin32Error();
            if (measured || nativeError != NativeMethods.ErrorInsufficientBuffer)
                throw new JobPreparationException("InitializeProcThreadAttributeList(size)", nativeError);
            Pointer = Marshal.AllocHGlobal(checked((nint)size.ToUInt64()));
            try { NativeMethods.CheckPreparation(NativeMethods.InitializeProcThreadAttributeList(Pointer, 2, 0, ref size), "InitializeProcThreadAttributeList"); }
            catch { Marshal.FreeHGlobal(Pointer); Pointer = IntPtr.Zero; throw; }
        }

        internal void SetHandles(UIntPtr attribute, IntPtr[] handles, UIntPtr byteSize)
        {
            var value = Marshal.AllocHGlobal(checked(handles.Length * IntPtr.Size));
            values.Add(value);
            Marshal.Copy(handles, 0, value, handles.Length);
            NativeMethods.CheckPreparation(NativeMethods.UpdateProcThreadAttribute(Pointer, 0, attribute, value, byteSize, IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");
        }

        public void Dispose()
        {
            if (Pointer == IntPtr.Zero) return;
            NativeMethods.DeleteProcThreadAttributeList(Pointer);
            foreach (var value in values) Marshal.FreeHGlobal(value);
            values.Clear();
            Marshal.FreeHGlobal(Pointer);
            Pointer = IntPtr.Zero;
        }
    }
}
