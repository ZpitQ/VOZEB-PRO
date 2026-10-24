using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsSupervisor;

internal sealed class KernelHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public KernelHandle() : base(true) { }
    internal KernelHandle(IntPtr value) : base(true) => SetHandle(value);
    protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
}

internal static class NativeMethods
{
    internal const uint Infinite = uint.MaxValue;
    internal const uint WaitObject0 = 0;
    internal const uint WaitTimeout = 258;
    internal const uint HandleFlagInherit = 1;
    internal const uint CreateSuspended = 0x00000004;
    internal const uint ExtendedStartupInfoPresent = 0x00080000;
    internal const uint CreateNoWindow = 0x08000000;
    internal const uint StartfUseStdHandles = 0x00000100;
    internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
    internal const int JobObjectBasicAccountingInformation = 1;
    internal const int JobObjectAssociateCompletionPortInformation = 7;
    internal const int JobObjectExtendedLimitInformation = 9;
    internal const int ErrorInsufficientBuffer = 122;
    internal const int ErrorAlreadyExists = 183;
    internal const int ErrorInvalidParameter = 87;
    internal const int ErrorMoreData = 234;
    internal const uint QueryProcessAndSynchronize = 0x00101000;
    internal const uint DuplicateSameAccess = 2;
    internal const uint ForcedExitCode = 1;
    internal static readonly UIntPtr JobCompletionKey = new(1);
    internal static readonly UIntPtr ProcThreadAttributeHandleList = new(0x00020002);
    internal static readonly UIntPtr ProcThreadAttributeJobList = new(0x0002000D);

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BasicLimitInformation
    {
        internal long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        internal ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ExtendedLimitInformation
    {
        internal BasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CompletionPortAssociation
    {
        internal UIntPtr CompletionKey;
        internal IntPtr CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BasicAccountingInformation
    {
        internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        internal uint Cb;
        internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        internal ushort ShowWindow, Reserved2Size;
        internal IntPtr Reserved2, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    internal static void Check(bool success, string stage)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), stage + " failed.");
    }

    internal static void CheckPreparation(bool success, string stage)
    {
        if (!success) throw new JobPreparationException(stage, Marshal.GetLastWin32Error());
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern KernelHandle CreateJobObjectW(ref SecurityAttributes security, string name);

    [DllImport("advapi32.dll")]
    internal static extern uint GetSecurityInfo(KernelHandle handle, ResourceType type, uint information,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    internal static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetJobLimits(KernelHandle job, int informationClass, ref ExtendedLimitInformation information, uint informationLength);

    [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssociateCompletionPort(KernelHandle job, int informationClass, ref CompletionPortAssociation information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern KernelHandle CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingPort, UIntPtr completionKey, uint concurrentThreads);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr completionKey, out IntPtr value, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObject(KernelHandle job, int informationClass, out BasicAccountingInformation information, uint informationLength, IntPtr returnedLength);

    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryJobProcessIds(KernelHandle job, int informationClass, IntPtr information, uint informationLength, out uint returnedLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern KernelHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DuplicateHandle(IntPtr sourceProcess, KernelHandle sourceHandle, IntPtr targetProcess,
        out SafeWaitHandle targetHandle, uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsProcessInJob(KernelHandle process, KernelHandle job, [MarshalAs(UnmanagedType.Bool)] out bool belongs);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetProcessTimes(KernelHandle process, out long created, out long exited, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessId(KernelHandle process);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(KernelHandle process, uint access, out KernelHandle token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetTokenInformation(KernelHandle token, int kind, IntPtr information,
        uint length, out uint required);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    internal static extern uint GetSystemDirectoryW(StringBuilder? buffer, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(KernelHandle process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(KernelHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(KernelHandle process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(KernelHandle thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(KernelHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetHandleInformation(SafeHandle handle, out uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetHandleInformation(SafeHandle handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SecurityAttributes security, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool InitializeProcThreadAttributeList(IntPtr list, uint attributeCount, uint flags, ref UIntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previousValue, IntPtr returnedSize);

    [DllImport("kernel32.dll")]
    internal static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfoEx startupInfo, out ProcessInformation processInformation);
}
