using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Zeb.StartupCallerPinProbe {
    public sealed class Identity {
        public int Pid; public uint Session;
        public string Creation, Image, Sid;
        public bool NonInherited, Alive;
    }
    public sealed class ExitIdentity {
        public int Pid;
        public string Creation, ExitFileTime;
        public uint ExitCode, WaitState;
        public bool NonInherited, Alive;
    }
    public sealed class ImageHash {
        public string Sha256, FileIdentity;
        public uint HardLinks;
        public long Length;
    }
    public sealed class Child : IDisposable {
        internal Process Process;
        internal Task<string> Stdout, Stderr;
        bool joined;
        public bool GuardianUsed;
        public int Pid { get { return Process.Id; } }
        public void StopAndJoin() {
            if (joined) return;
            if (!Process.HasExited) {
                Process.StandardInput.WriteLine(); Process.StandardInput.Close();
                if (!Process.WaitForExit(5000)) {
                    GuardianUsed = true; Process.Kill();
                    if (!Process.WaitForExit(2000)) throw new TimeoutException("probe_child_exit_unjoined");
                }
            }
            if (!Task.WaitAll(new Task[] { Stdout, Stderr }, 2000)) throw new TimeoutException("probe_child_drains_unjoined");
            joined = true;
        }
        public void Dispose() { try { StopAndJoin(); } finally { Process.Dispose(); } }
    }
    public static class Probe {
        [StructLayout(LayoutKind.Sequential)] struct FileInfo {
            public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetProcessTimes(SafeProcessHandle process, out ulong creation, out ulong exit, out ulong kernel, out ulong user);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeFileHandle token);
        [DllImport("advapi32.dll", SetLastError=true)]
        static extern bool GetTokenInformation(SafeFileHandle token, int kind, IntPtr value, uint length, out uint required);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess, SafeProcessHandle source, IntPtr targetProcess,
            out SafeProcessHandle duplicate, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
        static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        public static bool NonInherited(SafeHandle handle) { uint flags; Check(GetHandleInformation(handle, out flags)); return (flags & 1) == 0; }
        public static Identity Query(SafeProcessHandle process) {
            ulong creation, exit, kernel, user;
            uint pid = GetProcessId(process); if (pid == 0 || pid > int.MaxValue) throw new InvalidDataException("probe_pid_invalid");
            Check(GetProcessTimes(process, out creation, out exit, out kernel, out user));
            uint length = 32768; StringBuilder image = new StringBuilder((int)length);
            Check(QueryFullProcessImageName(process, 0, image, ref length));
            string sid; uint session;
            SafeFileHandle token; Check(OpenProcessToken(process, 8, out token));
            using (token) {
                uint required; GetTokenInformation(token, 1, IntPtr.Zero, 0, out required);
                if (required == 0 || required > 65536) throw new InvalidDataException("probe_token_bound");
                IntPtr raw = Marshal.AllocHGlobal((int)required);
                try { Check(GetTokenInformation(token, 1, raw, required, out required)); sid = new SecurityIdentifier(Marshal.ReadIntPtr(raw)).Value; }
                finally { Marshal.FreeHGlobal(raw); }
                IntPtr sessionRaw = Marshal.AllocHGlobal(4);
                try { Check(GetTokenInformation(token, 12, sessionRaw, 4, out required)); if (required != 4) throw new InvalidDataException("probe_session_bound"); session = unchecked((uint)Marshal.ReadInt32(sessionRaw)); }
                finally { Marshal.FreeHGlobal(sessionRaw); }
            }
            uint wait = WaitForSingleObject(process, 0);
            if (wait != 0 && wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new Identity { Pid=(int)pid, Creation=creation.ToString(CultureInfo.InvariantCulture), Image=image.ToString(),
                Sid=sid, Session=session, NonInherited=NonInherited(process), Alive=wait == 258 };
        }
        public static ExitIdentity QueryExit(SafeProcessHandle process) {
            if (process == null || process.IsClosed || process.IsInvalid) throw new InvalidDataException("probe_exit_handle_invalid");
            uint pid = GetProcessId(process); if (pid == 0 || pid > int.MaxValue) throw new InvalidDataException("probe_exit_pid_invalid");
            ulong creation, exit, kernel, user;
            Check(GetProcessTimes(process, out creation, out exit, out kernel, out user));
            uint wait = WaitForSingleObject(process, 0);
            if (wait != 0 && wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code; Check(GetExitCodeProcess(process, out code));
            return new ExitIdentity { Pid=(int)pid, Creation=creation.ToString(CultureInfo.InvariantCulture),
                ExitFileTime=exit.ToString(CultureInfo.InvariantCulture), ExitCode=code, WaitState=wait,
                NonInherited=NonInherited(process), Alive=wait == 258 };
        }
        public static Identity Current() {
            using (SafeProcessHandle process = OpenProcess(0x00101000, false, GetCurrentProcessId())) {
                if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error()); return Query(process);
            }
        }
        public static ImageHash HashStream(FileStream file) {
            if (file == null || !file.CanRead || !file.CanSeek || file.SafeFileHandle.IsClosed || file.SafeFileHandle.IsInvalid)
                throw new InvalidDataException("probe_image_stream_invalid");
            FileInfo info; Check(GetFileInformationByHandle(file.SafeFileHandle, out info));
            long position = file.Position;
            string hash;
            try {
                file.Position = 0;
                using (SHA256 sha = SHA256.Create())
                    hash = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            } finally { file.Position = position; }
            return new ImageHash { Sha256=hash, HardLinks=info.Links, Length=file.Length,
                FileIdentity=info.Volume.ToString("x8", CultureInfo.InvariantCulture) + ":" +
                    info.IndexHigh.ToString("x8", CultureInfo.InvariantCulture) + info.IndexLow.ToString("x8", CultureInfo.InvariantCulture) };
        }
        public static ImageHash HashImage(string actualKernelImage) {
            using (FileStream file = File.Open(actualKernelImage, FileMode.Open, FileAccess.Read, FileShare.Read))
                return HashStream(file);
        }
        public static SafeProcessHandle Duplicate(SafeProcessHandle original, bool inherit) {
            SafeProcessHandle duplicate;
            Check(DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out duplicate, 0, inherit, 2));
            return duplicate;
        }
        public static Child StartChild(string actualCurrentImage) {
            ProcessStartInfo info = new ProcessStartInfo(actualCurrentImage,
                "-NoProfile -NonInteractive -Command \"[void][Console]::In.ReadLine()\"");
            info.UseShellExecute=false; info.CreateNoWindow=true;
            info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
            Process child = Process.Start(info);
            return new Child { Process=child, Stdout=child.StandardOutput.ReadToEndAsync(), Stderr=child.StandardError.ReadToEndAsync() };
        }
    }
}
