using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Collections.Generic;
using System.Reflection;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;

namespace Zeb.StartupPipeProbe {
    public sealed class CallResult {
        public object Value; public string ErrorType; public long Milliseconds, StartedTick, FinishedTick; public bool Watchdog;
        public Task Invocation;
    }
    public sealed class ClientResult {
        public string ErrorType, CleanupErrorType, AckBase64; public bool HandleClosed; public int BytesWritten; public long[] WriteTicks;
    }
    public sealed class ClientTicket : IDisposable {
        internal ManualResetEventSlim Gate = new ManualResetEventSlim(false);
        public Task<ClientResult> Completion;
        public void Send() { Gate.Set(); }
        public void Dispose() { Gate.Dispose(); }
    }
    public sealed class AceResult {
        public string Sid, Qualifier; public int Mask, Flags; public bool Callback;
    }
    public sealed class Inspection {
        public string Owner; public bool Protected, DaclPresent, NonInherited, ServerEnd, ByteType;
        public uint MaximumInstances; public AceResult[] Aces;
    }
    public sealed class DuplicateResult { public bool Created, HandleClosed; public int Error; }
    public static class Probe {
        [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
        [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafePipeHandle Open(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", EntryPoint="CreateNamedPipeW", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafePipeHandle Create(string path, uint mode, uint pipeMode, uint instances, uint output, uint input, uint timeout, IntPtr security);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(SafeHandle handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetNamedPipeInfo(SafePipeHandle pipe, out uint flags, out uint output, out uint input, out uint maximum);
        [DllImport("advapi32.dll")]
        static extern uint GetSecurityInfo(SafePipeHandle pipe, int kind, uint fields, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);

        // Reflection runs the actual product method on a CLR thread, never an asynchronous PS scriptblock.
        public static CallResult Call(object target, string name, object[] args, int watchdogMs) {
            CallResult result = new CallResult(); Stopwatch clock = Stopwatch.StartNew();
            Task operation = Task.Factory.StartNew(delegate {
                result.StartedTick=checked((long)GetTickCount64());
                try {
                    MethodInfo method = target.GetType().GetMethod(name, BindingFlags.Public | BindingFlags.Instance);
                    if (method == null) throw new MissingMethodException(name);
                    result.Value = method.Invoke(target, args);
                } catch (TargetInvocationException failure) { result.ErrorType = failure.InnerException.GetType().Name; }
                  catch (Exception failure) { result.ErrorType = failure.GetType().Name; }
                finally { result.FinishedTick=checked((long)GetTickCount64()); }
            });
            result.Invocation = operation;
            if (!operation.Wait(watchdogMs)) result.Watchdog = true;
            result.Milliseconds = clock.ElapsedMilliseconds;
            return result;
        }
        public static bool Joined(Task operation, int milliseconds) { return operation == null || operation.Wait(milliseconds); }
        public static long Tick() { return checked((long)GetTickCount64()); }
        public static void Until(long cutoff) {
            long now = checked((long)GetTickCount64());
            if (cutoff - now > 1000) throw new InvalidOperationException("probe_delay_exceeds_bound");
            while (checked((long)GetTickCount64()) < cutoff) Thread.Sleep(1);
        }
        public static Inspection Inspect(SafePipeHandle pipe) {
            uint flags, mode, output, input, maximum;
            if (!GetHandleInformation(pipe, out flags) || !GetNamedPipeInfo(pipe, out mode, out output, out input, out maximum))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            IntPtr owner, group, dacl, sacl, descriptor;
            uint error = GetSecurityInfo(pipe, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new System.ComponentModel.Win32Exception((int)error);
            try {
                uint length = GetSecurityDescriptorLength(descriptor);
                if (length == 0 || length > 65536) throw new InvalidDataException("probe_descriptor_bound");
                byte[] raw = new byte[(int)length]; Marshal.Copy(descriptor, raw, 0, raw.Length);
                RawSecurityDescriptor actual = new RawSecurityDescriptor(raw, 0);
                AceResult[] aces = new AceResult[actual.DiscretionaryAcl == null ? 0 : actual.DiscretionaryAcl.Count];
                for (int index=0; index<aces.Length; index++) {
                    CommonAce ace = actual.DiscretionaryAcl[index] as CommonAce;
                    if (ace == null) throw new InvalidDataException("probe_non_common_ace");
                    aces[index] = new AceResult { Sid=ace.SecurityIdentifier.Value, Qualifier=ace.AceQualifier.ToString(),
                        Mask=ace.AccessMask, Flags=(int)ace.AceFlags, Callback=ace.IsCallback };
                }
                return new Inspection { Owner=actual.Owner == null ? null : actual.Owner.Value,
                    Protected=(actual.ControlFlags & ControlFlags.DiscretionaryAclProtected)!=0,
                    DaclPresent=(actual.ControlFlags & ControlFlags.DiscretionaryAclPresent)!=0,
                    NonInherited=(flags & 1)==0, ServerEnd=(mode & 1)!=0, ByteType=(mode & 4)==0,
                    MaximumInstances=maximum, Aces=aces };
            } finally { LocalFree(descriptor); }
        }
        public static DuplicateResult Duplicate(string leaf, bool first) {
            SafePipeHandle handle = Create(@"\\.\pipe\"+leaf, 0x40000003u | (first ? 0x00080000u : 0), 8, 1, 0, 0, 0, IntPtr.Zero);
            DuplicateResult result = new DuplicateResult { Created=!handle.IsInvalid, Error=handle.IsInvalid ? Marshal.GetLastWin32Error() : 0 };
            handle.Dispose(); result.HandleClosed=handle.IsClosed; return result;
        }
        static byte[] ReadExactly(Stream stream, int length) {
            byte[] raw = new byte[length]; int offset=0;
            while(offset<length) { int count=stream.Read(raw,offset,length-offset); if(count==0) throw new EndOfStreamException(); offset+=count; }
            return raw;
        }
        public static ClientTicket Client(string leaf, byte[] raw, int[] chunks, int pauseMs, int holdMs, bool readAck) {
            ClientTicket ticket = new ClientTicket();
            ticket.Completion = Task.Factory.StartNew(delegate {
                ClientResult result = new ClientResult(); SafePipeHandle handle=null; NamedPipeClientStream stream=null;
                List<long> ticks=new List<long>();
                try {
                    handle=Open(@"\\.\pipe\"+leaf, 0x0012019b, 0, IntPtr.Zero, 3, 0x40110000, IntPtr.Zero);
                    if(handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    uint flags; if(!GetHandleInformation(handle,out flags) || (flags & 1)!=0) throw new InvalidDataException("probe_client_inheritance");
                    stream=new NamedPipeClientStream(PipeDirection.InOut,true,true,handle);
                    if(!ticket.Gate.Wait(3000)) throw new TimeoutException("probe_send_gate");
                    int offset=0;
                    for(int index=0;index<chunks.Length;index++) {
                        int count=chunks[index]; if(count<0 || count>raw.Length-offset) throw new InvalidDataException("probe_chunk_bound");
                        stream.Write(raw,offset,count); stream.Flush(); offset+=count;
                        result.BytesWritten=offset; ticks.Add(checked((long)GetTickCount64()));
                        if(index+1<chunks.Length && pauseMs>0) Thread.Sleep(pauseMs);
                    }
                    if(offset!=raw.Length) throw new InvalidDataException("probe_chunk_total");
                    if(readAck) {
                        byte[] header=ReadExactly(stream,4); uint length=(uint)(header[0] | header[1]<<8 | header[2]<<16 | header[3]<<24);
                        if(length==0 || length>1024) throw new InvalidDataException("probe_ack_bound");
                        byte[] body=ReadExactly(stream,(int)length), wire=new byte[4+body.Length];
                        Buffer.BlockCopy(header,0,wire,0,4); Buffer.BlockCopy(body,0,wire,4,body.Length); result.AckBase64=Convert.ToBase64String(wire);
                    }
                    if(holdMs>0) Thread.Sleep(holdMs);
                } catch(Exception failure) { result.ErrorType=failure.GetType().Name; }
                finally {
                    try { if(stream!=null) stream.Dispose(); } catch(Exception failure) { result.CleanupErrorType=failure.GetType().Name; }
                    try { if(handle!=null) { handle.Dispose(); result.HandleClosed=handle.IsClosed; } }
                    catch(Exception failure) { if(result.CleanupErrorType==null) result.CleanupErrorType=failure.GetType().Name; }
                    result.WriteTicks=ticks.ToArray();
                }
                return result;
            });
            return ticket;
        }
    }
}
