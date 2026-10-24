using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Zeb.StartupExitCodeProbe {
    public sealed class ProbeWin32Failure : Win32Exception {
        public ProbeWin32Failure(string phase, int code) : base(code) { Data["startupExitProbePhase"]=phase; }
    }
    public sealed class LiveIdentity {
        public ExitIdentity Process;
        public string KernelImage;
    }
    public sealed class ExitIdentity {
        public int Pid;
        public string Creation, ExitFileTime;
        public uint WaitState, ExitCode;
        public long HandleValue;
        public bool NonInherited, Alive;
    }
    public sealed class Child : IDisposable {
        internal Process Process;
        internal Task<string> Stdout, Stderr;
        bool joined;
        public bool GuardianUsed;
        public int Pid { get { return Process.Id; } }
        public void ReleaseAndJoin() {
            try {
                if (joined) return;
                Probe.Step("Child.ReleaseAndJoin.HasExited"); bool exited=Process.HasExited; Probe.Done();
                if (!exited) {
                    Probe.Step("Child.ReleaseAndJoin.stdin.WriteLine"); Process.StandardInput.WriteLine(); Probe.Done();
                    Probe.Step("Child.ReleaseAndJoin.stdin.Close"); Process.StandardInput.Close(); Probe.Done();
                    Probe.Step("Child.ReleaseAndJoin.WaitForExit5000"); bool natural=Process.WaitForExit(5000); Probe.Done();
                    if (!natural) {
                        GuardianUsed=true;
                        Probe.Step("Child.ReleaseAndJoin.guardian.Kill"); Process.Kill(); Probe.Done();
                        Probe.Step("Child.ReleaseAndJoin.guardian.WaitForExit2000"); bool joinedAfterKill=Process.WaitForExit(2000); Probe.Done();
                        if (!joinedAfterKill) throw new TimeoutException("exit_probe_child_unjoined");
                    }
                }
                Probe.Step("Child.ReleaseAndJoin.Task.WaitAll"); bool drained=Task.WaitAll(new Task[] { Stdout, Stderr }, 2000); Probe.Done();
                if (!drained) throw new TimeoutException("exit_probe_drains_unjoined");
                joined=true;
            } catch (Exception failure) { Probe.MarkFailure(failure); throw; }
        }
        public void Dispose() {
            try { ReleaseAndJoin(); }
            finally {
                try {
                    Probe.Step("Child.Dispose.HasExited"); bool exited=Process.HasExited; Probe.Done();
                    if (!exited) {
                        GuardianUsed=true;
                        Probe.Step("Child.Dispose.guardian.Kill"); Process.Kill(); Probe.Done();
                        Probe.Step("Child.Dispose.guardian.WaitForExit2000"); bool joinedAfterKill=Process.WaitForExit(2000); Probe.Done();
                        if (!joinedAfterKill) throw new TimeoutException("exit_probe_cleanup_unjoined");
                    }
                } finally { Probe.Step("Child.Dispose.Process.Dispose"); Process.Dispose(); Probe.Done(); }
            }
        }
    }
    public static class Probe {
        public static string Phase { get; private set; }
        public static string LastCompletedPhase { get; private set; }
        internal static void Step(string phase) { Phase=phase; }
        internal static void Done() { LastCompletedPhase=Phase; }
        internal static void MarkFailure(Exception failure) {
            if (!failure.Data.Contains("startupExitProbePhase")) failure.Data["startupExitProbePhase"]=Phase;
        }
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetProcessTimes(SafeProcessHandle process, out ulong creation, out ulong exit, out ulong kernel, out ulong user);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess, SafeProcessHandle source, IntPtr targetProcess,
            out SafeProcessHandle duplicate, uint access, bool inherit, uint options);
        static void Check(bool value) {
            if (!value) throw new ProbeWin32Failure(Phase, Marshal.GetLastWin32Error());
            Done();
        }
        public static ExitIdentity QueryExit(SafeProcessHandle process) {
            Step("QueryExit.validate_handle");
            if (process == null || process.IsClosed || process.IsInvalid) throw new InvalidDataException("exit_probe_handle_invalid");
            Done();
            Step("QueryExit.GetProcessId"); uint pid=GetProcessId(process);
            if (pid == 0) throw new ProbeWin32Failure(Phase, Marshal.GetLastWin32Error());
            if (pid > int.MaxValue) throw new InvalidDataException("exit_probe_pid_invalid");
            Done();
            ulong creation, exit, kernel, user;
            Step("QueryExit.GetProcessTimes"); Check(GetProcessTimes(process, out creation, out exit, out kernel, out user));
            uint flags; Step("QueryExit.GetHandleInformation"); Check(GetHandleInformation(process, out flags));
            Step("QueryExit.WaitForSingleObject"); uint wait=WaitForSingleObject(process, 0);
            if (wait != 0 && wait != 258) throw new ProbeWin32Failure(Phase, Marshal.GetLastWin32Error());
            Done();
            uint code; Step("QueryExit.GetExitCodeProcess"); Check(GetExitCodeProcess(process, out code));
            Step("QueryExit.project");
            return new ExitIdentity { Pid=(int)pid, Creation=creation.ToString(CultureInfo.InvariantCulture),
                ExitFileTime=exit.ToString(CultureInfo.InvariantCulture), WaitState=wait, ExitCode=code,
                HandleValue=process.DangerousGetHandle().ToInt64(), NonInherited=(flags & 1) == 0, Alive=wait == 258 };
        }
        public static LiveIdentity QueryLive(SafeProcessHandle process) {
            ExitIdentity before=QueryExit(process);
            Step("QueryLive.require_live_before");
            if (!before.Alive || before.WaitState != 258) throw new InvalidDataException("exit_probe_live_identity_required");
            Done();
            uint length=32768; StringBuilder image=new StringBuilder((int)length);
            Step("QueryLive.QueryFullProcessImageName"); Check(QueryFullProcessImageName(process, 0, image, ref length));
            ExitIdentity after=QueryExit(process);
            Step("QueryLive.same_original_still_live");
            if (!after.Alive || after.WaitState != 258 || before.Pid != after.Pid || before.Creation != after.Creation ||
                before.HandleValue != after.HandleValue || before.NonInherited != after.NonInherited)
                throw new InvalidDataException("exit_probe_live_identity_changed");
            Done();
            return new LiveIdentity { Process=after, KernelImage=image.ToString() };
        }
        public static SafeProcessHandle Duplicate(SafeProcessHandle original, bool inherit) {
            SafeProcessHandle duplicate;
            Step("Duplicate.DuplicateHandle"); Check(DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out duplicate, 0, inherit, 2));
            return duplicate;
        }
        public static Child StartChild(string actualCurrentImage, int exitCode) {
            Step("StartChild.validate_exit_code");
            if (exitCode != 0 && exitCode != 2) throw new ArgumentOutOfRangeException("exitCode");
            Done();
            ProcessStartInfo info=new ProcessStartInfo(actualCurrentImage,
                "-NoProfile -NonInteractive -Command \"[void][Console]::In.ReadLine();[Environment]::Exit(" +
                exitCode.ToString(CultureInfo.InvariantCulture) + ")\"");
            info.UseShellExecute=false; info.CreateNoWindow=true;
            info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
            Step("StartChild.Process.Start"); Process process=Process.Start(info); Done();
            try {
                Step("StartChild.stdout.ReadToEndAsync"); Task<string> stdout=process.StandardOutput.ReadToEndAsync(); Done();
                Step("StartChild.stderr.ReadToEndAsync"); Task<string> stderr=process.StandardError.ReadToEndAsync(); Done();
                return new Child { Process=process, Stdout=stdout, Stderr=stderr };
            } catch (Exception failure) {
                MarkFailure(failure);
                try { if (!process.HasExited) { process.Kill(); process.WaitForExit(2000); } }
                finally { process.Dispose(); }
                throw;
            }
        }
    }
}
