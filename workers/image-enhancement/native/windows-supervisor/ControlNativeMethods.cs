using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsSupervisor;

internal sealed class ControlKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public ControlKernelHandle() : base(true) { }
    protected override bool ReleaseHandle() => ControlNativeMethods.CloseHandle(handle);
}

internal sealed class ControlProcess : IDisposable
{
    private ControlProcess(ControlKernelHandle handle, uint pid, ulong creationTime, SecurityIdentifier user)
    {
        Handle = handle;
        Pid = pid;
        CreationTime = creationTime;
        User = user;
    }

    private ControlKernelHandle Handle { get; }
    internal uint Pid { get; }
    internal ulong CreationTime { get; }
    internal SecurityIdentifier User { get; }

    internal static ControlProcess Open(uint pid)
    {
        ControlKernelHandle handle = ControlNativeMethods.OpenProcess(0x00101000, false, pid);
        try
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            ControlNativeMethods.RequireNoninherited(handle);
            uint actualPid = ControlNativeMethods.GetProcessId(handle);
            if (actualPid == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (actualPid != pid) throw new InvalidOperationException();
            if (!ControlNativeMethods.GetProcessTimes(handle, out ulong creation, out _, out _, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return new ControlProcess(handle, actualPid, creation, ControlNativeMethods.ReadUser(handle));
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    internal void RequireRunning()
    {
        uint result = ControlNativeMethods.WaitForSingleObject(Handle, 0);
        if (result == 0) throw new InvalidOperationException();
        if (result != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    internal void WaitForExit()
    {
        if (ControlNativeMethods.WaitForSingleObject(Handle, uint.MaxValue) != 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    internal async Task WaitForExitAsync(CancellationToken cancellationToken)
    {
        bool borrowed = false;
        try
        {
            Handle.DangerousAddRef(ref borrowed);
            using var processWait = new BorrowedProcessWait(Handle.DangerousGetHandle());
            using var canceled = new ManualResetEvent(false);
            using (cancellationToken.Register(() => canceled.Set()))
            {
                int selected = await Task.Run(() => WaitHandle.WaitAny([processWait, canceled]));
                if (selected == 1) throw new OperationCanceledException(cancellationToken);
                if (selected != 0) throw new InvalidOperationException();
            }
        }
        finally
        {
            if (borrowed) Handle.DangerousRelease();
        }
    }

    private sealed class BorrowedProcessWait : WaitHandle
    {
        internal BorrowedProcessWait(IntPtr handle) => SafeWaitHandle = new SafeWaitHandle(handle, false);
    }

    public void Dispose() => Handle.Dispose();
}

internal static class ControlNativeMethods
{
    private const int PipeFullControl = 0x001f019f;
    private const uint OwnerAndDacl = 0x00000005;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
    }

    internal static void RequireNoninherited(SafeHandle handle)
    {
        if (!GetHandleInformation(handle, out uint flags))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((flags & 1) != 0) throw new InvalidOperationException();
    }

    internal static SecurityIdentifier ReadUser(ControlKernelHandle process)
    {
        if (!OpenProcessToken(process, 0x0008, out ControlKernelHandle token))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        using (token)
        {
            RequireNoninherited(token);
            if (GetTokenInformation(token, 1, IntPtr.Zero, 0, out uint length) ||
                Marshal.GetLastWin32Error() != 122 || length == 0)
                throw new InvalidOperationException();
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

    internal static ControlProcess OpenClient(SafePipeHandle pipe)
    {
        RequireNoninherited(pipe);
        if (!GetNamedPipeClientProcessId(pipe, out uint pid))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return ControlProcess.Open(pid);
    }

    internal static NamedPipeServerStream CreatePipe(string leaf, SecurityIdentifier user, bool first)
    {
        var acl = new RawAcl(GenericAcl.AclRevision, 1);
        acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, PipeFullControl, user, false, null));
        var descriptor = new RawSecurityDescriptor(ControlFlags.SelfRelative | ControlFlags.DiscretionaryAclPresent |
            ControlFlags.DiscretionaryAclProtected, user, null, null, acl);
        byte[] binary = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(binary, 0);
        GCHandle pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
        SafePipeHandle pipe;
        try
        {
            var security = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = pinned.AddrOfPinnedObject(), Inherit = false,
            };
            pipe = CreateNamedPipeW("\\\\.\\pipe\\" + leaf, 0x00000003u | 0x40000000u | (first ? 0x00080000u : 0),
                0x00000008, 255, 0, 0, 0, ref security);
        }
        finally { pinned.Free(); }
        try
        {
            if (pipe.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            RequireNoninherited(pipe);
            VerifySecurity(pipe, user);
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, pipe);
        }
        catch
        {
            pipe.Dispose();
            throw;
        }
    }

    private static void VerifySecurity(SafePipeHandle pipe, SecurityIdentifier user)
    {
        uint error = GetSecurityInfo(pipe, ResourceType.KernelObject, OwnerAndDacl,
            out _, out _, out _, out _, out IntPtr descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try
        {
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] binary = new byte[checked((int)length)];
            Marshal.Copy(descriptor, binary, 0, binary.Length);
            var actual = new RawSecurityDescriptor(binary, 0);
            SecurityIdentifier? owner = actual.Owner;
            const ControlFlags required = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected;
            if (owner is null || !user.Equals(owner) || (actual.ControlFlags & required) != required ||
                actual.DiscretionaryAcl is not { Count: 1 } dacl || dacl[0] is not CommonAce ace ||
                ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None || ace.IsCallback ||
                ace.AccessMask != PipeFullControl || !user.Equals(ace.SecurityIdentifier))
                throw new InvalidOperationException();
        }
        finally { LocalFree(descriptor); }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern ControlKernelHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessId(ControlKernelHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetProcessTimes(ControlKernelHandle process, out ulong creation, out ulong exit,
        out ulong kernel, out ulong user);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(ControlKernelHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint mode, uint pipeMode, uint instances,
        uint outBuffer, uint inBuffer, uint defaultTimeout, ref SecurityAttributes security);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(ControlKernelHandle process, uint access, out ControlKernelHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(ControlKernelHandle token, int informationClass, IntPtr information,
        uint length, out uint required);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafePipeHandle handle, ResourceType type, uint information,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);
}
