using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsControlBridge;

internal sealed class OriginalProcessPin : IDisposable
{
    private readonly SafeProcessHandle handle;
    internal uint Pid { get; }
    internal ulong CreationFileTime { get; }
    internal SecurityIdentifier User { get; }
    internal object WireIdentity => new
    {
        pid = Pid, creationFileTime = CreationFileTime.ToString(CultureInfo.InvariantCulture),
    };

    private OriginalProcessPin(SafeProcessHandle original)
    {
        handle = original;
        try
        {
            BridgeNativeMethods.RequireNoninherited(handle);
            Pid = BridgeNativeMethods.GetProcessId(handle);
            if (Pid == 0 || !BridgeNativeMethods.GetProcessTimes(handle, out ulong created, out _, out _, out _) || created == 0)
                throw new InvalidDataException();
            CreationFileTime = created;
            User = BridgeNativeMethods.ReadUser(handle);
            RequireIdentity();
        }
        catch { handle.Dispose(); throw; }
    }

    internal static OriginalProcessPin Current() => new(BridgeNativeMethods.DuplicateCurrent());

    internal static OriginalProcessPin OpenCandidate(uint pid) => new(BridgeNativeMethods.OpenProcess(0x00101000, false, pid));

    internal (string ImagePath, uint SessionId) RuntimeIdentity()
    {
        RequireIdentity();
        var image = new StringBuilder(32768);
        uint length = (uint)image.Capacity;
        if (!BridgeNativeMethods.QueryFullProcessImageNameW(handle, 0, image, ref length) || length == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        uint session = BridgeNativeMethods.ReadSession(handle);
        RequireIdentity();
        if (IsSignaled()) throw new InvalidDataException();
        return (image.ToString(), session);
    }

    internal static OriginalProcessPin FromSuccessfulStart(Process original)
    {
        // The audited runtime stores CreateProcess's original hProcess on this
        // same, undisposed Process. Never select or reopen a process by its PID.
        SafeProcessHandle source = original.SafeHandle;
        bool borrowed = false;
        try
        {
            source.DangerousAddRef(ref borrowed);
            return new(BridgeNativeMethods.DuplicateOriginal(source.DangerousGetHandle()));
        }
        finally { if (borrowed) source.DangerousRelease(); }
    }

    internal void RequireIdentity()
    {
        BridgeNativeMethods.RequireNoninherited(handle);
        if (BridgeNativeMethods.GetProcessId(handle) != Pid ||
            !BridgeNativeMethods.GetProcessTimes(handle, out ulong created, out _, out _, out _) ||
            created != CreationFileTime || !BridgeNativeMethods.ReadUser(handle).Equals(User))
            throw new InvalidDataException();
    }

    internal bool IsSignaled()
    {
        uint result = BridgeNativeMethods.WaitForSingleObject(handle, 0);
        if (result == 0) return true;
        if (result == 258) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    internal void VerifyPeer(SafePipeHandle pipe)
    {
        BridgeNativeMethods.RequireNoninherited(pipe);
        if (!BridgeNativeMethods.GetNamedPipeServerProcessId(pipe, out uint peer) || peer != Pid)
            throw new InvalidDataException();
        RequireIdentity();
        // This is deliberately after the peer query and uses the original pin.
        if (IsSignaled()) throw new InvalidDataException();
    }

    internal Task<uint> WaitForExitAsync() => Task.Run(() =>
    {
        bool borrowed = false;
        try
        {
            handle.DangerousAddRef(ref borrowed);
            if (BridgeNativeMethods.WaitForSingleObject(handle, uint.MaxValue) != 0 ||
                !BridgeNativeMethods.GetExitCodeProcess(handle, out uint code))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return code;
        }
        finally { if (borrowed) handle.DangerousRelease(); }
    });

    internal void TerminateNoEngineHelperOnce()
    {
        RequireIdentity();
        if (!BridgeNativeMethods.TerminateProcess(handle, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Dispose() => handle.Dispose();
}

internal sealed class BridgeTokenHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public BridgeTokenHandle() : base(true) { }
    protected override bool ReleaseHandle() => BridgeNativeMethods.CloseHandle(handle);
}

internal sealed class BridgeServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public BridgeServiceHandle() : base(true) { }
    protected override bool ReleaseHandle() => BridgeNativeMethods.CloseServiceHandle(handle);
}

// Pins belong to this one marked bridge session, including an Unknown observation.
internal sealed class BootBackgroundObservation(OriginalProcessPin bridge) : IDisposable
{
    private readonly object gate = new();
    private OriginalProcessPin? host, worker;
    private string? candidateSid, hostPath, workerPath, bridgePath, failure;
    private bool captured, publishedObserved;
    private static JsonElement Unknown(string reason) => JsonSerializer.SerializeToElement(new { state = "unknown", reason });

    internal void Capture()
    {
        lock (gate)
        {
            if (captured) throw new InvalidOperationException();
            captured = true;
            try
            {
                bridgePath = bridge.RuntimeIdentity().ImagePath;
                string directory = Path.GetDirectoryName(bridgePath)!;
                string native = Path.GetDirectoryName(directory)!;
                string payload = Path.GetDirectoryName(native)!;
                if (!string.Equals(Path.GetFileName(bridgePath), "WindowsControlBridge.exe", StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(Path.GetFileName(directory), "bridge", StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(Path.GetFileName(native), "native", StringComparison.OrdinalIgnoreCase) ||
                    !Path.IsPathFullyQualified(payload)) throw new InvalidDataException();
                workerPath = Path.Combine(payload, "runtime", "node.exe");
                hostPath = Path.Combine(payload, "WindowsServiceHost.exe");
                Dictionary<uint, uint> parents = BridgeNativeMethods.Parents();
                if (!parents.TryGetValue(bridge.Pid, out uint node) || node == 0 ||
                    !parents.TryGetValue(node, out uint service) || service == 0 || node == service || node == bridge.Pid || service == bridge.Pid)
                    throw new InvalidDataException();
                worker = OriginalProcessPin.OpenCandidate(node);
                host = OriginalProcessPin.OpenCandidate(service);
                candidateSid = new NTAccount("NT SERVICE", "ZebImageEnhancement").Translate(typeof(SecurityIdentifier)).Value;
                Validate();
            }
            catch (Exception error) { failure = Reason(error); }
        }
    }

    private void Validate()
    {
        if (host is null || worker is null || candidateSid is null) throw new InvalidDataException();
        BridgeNativeMethods.RequireRunningService(host.Pid);
        bridge.RequireIdentity(); host.RequireIdentity(); worker.RequireIdentity();
        var actualBridge = bridge.RuntimeIdentity();
        var actualHost = host.RuntimeIdentity();
        var actualWorker = worker.RuntimeIdentity();
        if (!string.Equals(actualBridge.ImagePath, bridgePath, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(actualHost.ImagePath, hostPath, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(actualWorker.ImagePath, workerPath, StringComparison.OrdinalIgnoreCase) ||
            actualHost.SessionId != 0 || actualWorker.SessionId != 0 ||
            host.User.Value != candidateSid || worker.User.Value != candidateSid || bridge.User.Value != candidateSid ||
            host.CreationFileTime > worker.CreationFileTime || worker.CreationFileTime > bridge.CreationFileTime)
            throw new InvalidDataException();
        Dictionary<uint, uint> parents = BridgeNativeMethods.Parents();
        if (!parents.TryGetValue(bridge.Pid, out uint node) || node != worker.Pid ||
            !parents.TryGetValue(worker.Pid, out uint service) || service != host.Pid) throw new InvalidDataException();
        BridgeNativeMethods.RequireRunningService(host.Pid);
        if (bridge.IsSignaled() || host.IsSignaled() || worker.IsSignaled()) throw new InvalidDataException();
    }

    internal JsonElement Snapshot()
    {
        lock (gate)
        {
            if (!captured) return Unknown("unavailable");
            if (failure is not null) return Unknown(failure);
            try
            {
                Validate();
                return JsonSerializer.SerializeToElement(new
                {
                    state = "observed", host = host!.WireIdentity,
                    worker = new { pid = worker!.Pid, creationFileTime = worker.CreationFileTime.ToString(CultureInfo.InvariantCulture),
                        userSid = worker.User.Value, sessionId = 0u },
                });
            }
            catch (Exception error) { failure = Reason(error); return Unknown(failure); }
        }
    }
    internal bool RevalidateForClose()
    {
        JsonElement current = Snapshot();
        lock (gate) return !publishedObserved || current.GetProperty("state").GetString() == "observed";
    }
    internal void MarkPublishedObserved() { lock (gate) publishedObserved = true; }
    private static string Reason(Exception error) => error is Win32Exception native
        ? native.NativeErrorCode == 5 ? "permission" : "unavailable"
        : error is PlatformNotSupportedException ? "unsupported" : error is IdentityNotMappedException ? "unavailable" : "identity";
    public void Dispose()
    {
        lock (gate) { worker?.Dispose(); host?.Dispose(); }
    }
}

internal static class BridgeNativeMethods
{
    internal static SafeProcessHandle DuplicateCurrent() => DuplicateOriginal(new IntPtr(-1));

    internal static SafeProcessHandle DuplicateOriginal(IntPtr source)
    {
        if (!DuplicateHandle(new IntPtr(-1), source, new IntPtr(-1), out SafeProcessHandle duplicate, 0, false, 2))
        {
            duplicate?.Dispose();
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            if (duplicate.IsInvalid) throw new InvalidDataException();
            RequireNoninherited(duplicate);
            return duplicate;
        }
        catch { duplicate.Dispose(); throw; }
    }

    internal static void RequireNoninherited(SafeHandle handle)
    {
        if (!GetHandleInformation(handle, out uint flags))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((flags & 1) != 0) throw new InvalidDataException();
    }

    internal static SecurityIdentifier ReadUser(SafeProcessHandle process)
    {
        if (!OpenProcessToken(process, 0x0008, out BridgeTokenHandle token))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        using (token)
        {
            RequireNoninherited(token);
            if (GetTokenInformation(token, 1, IntPtr.Zero, 0, out uint length) ||
                Marshal.GetLastWin32Error() != 122 || length == 0)
                throw new InvalidDataException();
            IntPtr buffer = Marshal.AllocHGlobal(checked((int)length));
            try
            {
                if (!GetTokenInformation(token, 1, buffer, length, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    internal static uint ReadSession(SafeProcessHandle process)
    {
        if (!OpenProcessToken(process, 8, out BridgeTokenHandle token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        using (token)
        {
            RequireNoninherited(token);
            IntPtr value = Marshal.AllocHGlobal(sizeof(uint));
            try
            {
                if (!GetTokenInformation(token, 12, value, sizeof(uint), out uint returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (returned != sizeof(uint)) throw new InvalidDataException();
                return unchecked((uint)Marshal.ReadInt32(value));
            }
            finally { Marshal.FreeHGlobal(value); }
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        internal uint Size, Usage, Pid;
        internal UIntPtr Heap;
        internal uint Module, Threads, ParentPid;
        internal int Priority;
        internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string? Executable;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        internal uint Type, State, Accepted, Win32Exit, ServiceExit, Checkpoint, WaitHint, Pid, Flags;
    }
    internal static Dictionary<uint, uint> Parents()
    {
        using SafeFileHandle snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        RequireNoninherited(snapshot);
        var entries = new Dictionary<uint, uint>();
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
        bool present = Process32FirstW(snapshot, ref entry);
        while (present)
        {
            if (!entries.TryAdd(entry.Pid, entry.ParentPid)) throw new InvalidDataException();
            entry.Size = (uint)Marshal.SizeOf<ProcessEntry>();
            present = Process32NextW(snapshot, ref entry);
        }
        if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
        return entries;
    }
    internal static void RequireRunningService(uint hostPid)
    {
        using BridgeServiceHandle manager = OpenSCManagerW(null, null, 1);
        if (manager.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        using BridgeServiceHandle service = OpenServiceW(manager, "ZebImageEnhancement", 4);
        if (service.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint size = (uint)Marshal.SizeOf<ServiceStatus>();
        if (!QueryServiceStatusEx(service, 0, out ServiceStatus status, size, out uint returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
        // pcbBytesNeeded is required capacity, not a success byte count.
        if (returned > size || status.State != 4 || status.Pid != hostPid) throw new InvalidDataException();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder name, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern BridgeServiceHandle OpenSCManagerW(string? machine, string? database, uint access);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern BridgeServiceHandle OpenServiceW(BridgeServiceHandle manager, string name, uint access);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(BridgeServiceHandle service, int kind, out ServiceStatus status, uint bytes, out uint needed);
    [DllImport("advapi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseServiceHandle(IntPtr service);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out SafeProcessHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessId(SafeProcessHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetProcessTimes(SafeProcessHandle process, out ulong creation, out ulong exit,
        out ulong kernel, out ulong user);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out BridgeTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(BridgeTokenHandle token, int informationClass, IntPtr information,
        uint length, out uint required);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);
}
