using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Zeb.WindowsSupervisor;

// This is one boot observation, not a device selector or an execution permission.
internal sealed class NvmlObservation
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        internal uint Pid;
        internal ulong UsedGpuMemory;
        internal uint GpuInstanceId, ComputeInstanceId;
    }

    private sealed class ObservationFailure(string reason) : Exception
    {
        internal string Reason { get; } = reason;
    }

    internal static JsonElement Unknown(string reason) => NativeExecutionSession.Element(new { state = "unknown", reason });

#if ZEB_NATIVE_TESTS
    private readonly SessionTestBridge? bridge;
    private readonly NativeExecutionSession session;
    private readonly string? fault;
    private int initCalls, shutdownCalls, graphicsCountCalls, graphicsFillCalls, computeCountCalls, computeFillCalls;
    private int nativeCallsInFlight, resourcesAcquired, resourcesFreed, unavailableMemorySeen, barrier;
    internal NvmlObservation(SessionTestBridge? bridge, NativeExecutionSession session)
    {
        this.bridge = bridge; this.session = session;
        fault = bridge?.FaultAt("observation", "BeforeNativeReturn");
    }
    internal object TestCounters() => new
    {
        initCalls = Volatile.Read(ref initCalls), shutdownCalls = Volatile.Read(ref shutdownCalls),
        graphicsCountCalls = Volatile.Read(ref graphicsCountCalls), graphicsFillCalls = Volatile.Read(ref graphicsFillCalls),
        computeCountCalls = Volatile.Read(ref computeCountCalls), computeFillCalls = Volatile.Read(ref computeFillCalls),
        nativeCallsInFlight = Volatile.Read(ref nativeCallsInFlight), resourcesAcquired = Volatile.Read(ref resourcesAcquired),
        resourcesFreed = Volatile.Read(ref resourcesFreed), processInfoSize = Marshal.SizeOf<ProcessInfo>(),
        unavailableMemorySeen = Volatile.Read(ref unavailableMemorySeen) != 0,
    };
#endif

    internal JsonElement Sample(uint enginePid, long executionDeadlineAt)
    {
        Api? api = null;
        bool initialized = false;
        JsonElement result = Unknown("unavailable");
        try
        {
            if (IntPtr.Size != 8 || Marshal.SizeOf<ProcessInfo>() != 24) throw new ObservationFailure("unsupported");
            Budget(executionDeadlineAt);
            api = new Api(this, enginePid);
            Budget(executionDeadlineAt);
            Check(api.Init()); initialized = true;
            Budget(executionDeadlineAt);
            string driver = api.Driver();
            uint count = 0;
            Budget(executionDeadlineAt); Check(api.Count(ref count));
            var devices = new List<object>();
            for (uint index = 0; index < count; index++)
            {
                Budget(executionDeadlineAt); Check(api.Handle(index, out IntPtr device));
                if (device == IntPtr.Zero) throw new ObservationFailure("incomplete");
                bool graphics = Match(api, device, true, enginePid, executionDeadlineAt);
                bool compute = Match(api, device, false, enginePid, executionDeadlineAt);
                if (!graphics && !compute) continue;
                Budget(executionDeadlineAt); string name = api.Name(device);
                Budget(executionDeadlineAt); string? uuid = api.Uuid(device);
                devices.Add(new { nvmlIndex = index, name, uuid, graphics, compute });
            }
            Budget(executionDeadlineAt);
            result = devices.Count == 0 ? Unknown("no-match") : NativeExecutionSession.Element(new
            {
                state = "observed", driverVersion = driver, devices,
            });
        }
        catch (ObservationFailure failure) { result = Unknown(failure.Reason); }
        catch (Win32Exception failure) { result = Unknown(failure.NativeErrorCode == 5 ? "permission" : "unavailable"); }
        catch (Exception failure) when (failure is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or PlatformNotSupportedException)
        { result = Unknown("unsupported"); }
        catch (Exception failure) when (failure is OverflowException or ArgumentException or InvalidDataException)
        { result = Unknown("incomplete"); }
        catch (OutOfMemoryException) { result = Unknown("unavailable"); }
        finally
        {
            if (api is not null)
            {
                try { if (initialized && api.Shutdown() != 0) result = Unknown("unavailable"); }
                finally { api.Dispose(); }
            }
        }
        return result;
    }

    private bool Match(Api api, IntPtr device, bool graphics, uint pid, long deadline)
    {
        uint count = 0;
        Budget(deadline);
        uint status = api.Processes(device, graphics, ref count, IntPtr.Zero);
        if (status == 0 && count == 0) return false;
        if (status != 7) { Check(status); throw new ObservationFailure("incomplete"); }
        if (count == 0 || count > Array.MaxLength) throw new ObservationFailure("incomplete");
        int bytes = checked((int)count * Marshal.SizeOf<ProcessInfo>());
        if (bytes > Array.MaxLength) throw new ObservationFailure("incomplete");
        IntPtr buffer = Marshal.AllocHGlobal(bytes);
#if ZEB_NATIVE_TESTS
        Interlocked.Increment(ref resourcesAcquired);
#endif
        try
        {
            uint capacity = count;
            Budget(deadline);
            Check(api.Processes(device, graphics, ref count, buffer));
            if (count > capacity) throw new ObservationFailure("incomplete");
            bool found = false;
            for (uint index = 0; index < count; index++)
            {
                var info = Marshal.PtrToStructure<ProcessInfo>(IntPtr.Add(buffer, checked((int)index * Marshal.SizeOf<ProcessInfo>())));
                if (info.Pid != pid) continue;
                found = true;
#if ZEB_NATIVE_TESTS
                if (info.UsedGpuMemory == ulong.MaxValue) Volatile.Write(ref unavailableMemorySeen, 1);
#endif
            }
            return found;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
#if ZEB_NATIVE_TESTS
            Interlocked.Increment(ref resourcesFreed);
#endif
        }
    }

    private static void Budget(long deadline)
    {
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > deadline) throw new ObservationFailure("deadline");
    }
    private static void Check(uint status)
    {
        if (status != 0) throw new ObservationFailure(status switch { 4 => "permission", 3 => "unsupported", 7 => "incomplete", _ => "unavailable" });
    }
    private static string Decode(byte[] bytes)
    {
        int end = Array.IndexOf(bytes, (byte)0);
        if (end <= 0) throw new ObservationFailure("incomplete");
        string text = new UTF8Encoding(false, true).GetString(bytes, 0, end);
        if (text.Trim() != text || text[0] == '\ufeff' || text[^1] == '\ufeff' || text.Any(value => char.IsControl(value)))
            throw new ObservationFailure("incomplete");
        return text;
    }

    private sealed class Api : IDisposable
    {
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint SimpleFn();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint CountFn(ref uint count);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint HandleFn(uint index, out IntPtr device);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint ProcessesFn(IntPtr device, ref uint count, IntPtr values);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint TextFn(IntPtr device, [Out] byte[] text, uint length);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint DriverFn([Out] byte[] text, uint length);
        private readonly NvmlObservation owner;
        private readonly uint pid;
        private IntPtr library;
        private readonly SimpleFn? init, shutdown;
        private readonly CountFn? count;
        private readonly HandleFn? handle;
        private readonly ProcessesFn? graphics, compute;
        private readonly TextFn? name, uuid;
        private readonly DriverFn? driver;

        internal Api(NvmlObservation owner, uint pid)
        {
            this.owner = owner; this.pid = pid;
#if ZEB_NATIVE_TESTS
            if (owner.fault is not null) return;
#endif
            uint needed = NativeMethods.GetSystemDirectoryW(null, 0);
            if (needed == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            var path = new StringBuilder(checked((int)needed));
            uint written = NativeMethods.GetSystemDirectoryW(path, (uint)path.Capacity);
            if (written == 0 || written >= path.Capacity || !Path.IsPathFullyQualified(path.ToString()))
                throw new ObservationFailure("unsupported");
            library = NativeLibrary.Load(Path.Combine(path.ToString(), "nvml.dll"), typeof(NvmlObservation).Assembly, DllImportSearchPath.System32);
#if ZEB_NATIVE_TESTS
            Interlocked.Increment(ref owner.resourcesAcquired);
#endif
            try
            {
                T Export<T>(string symbol) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(library, symbol));
                init = Export<SimpleFn>("nvmlInit_v2"); shutdown = Export<SimpleFn>("nvmlShutdown");
                count = Export<CountFn>("nvmlDeviceGetCount_v2"); handle = Export<HandleFn>("nvmlDeviceGetHandleByIndex_v2");
                graphics = Export<ProcessesFn>("nvmlDeviceGetGraphicsRunningProcesses_v3");
                compute = Export<ProcessesFn>("nvmlDeviceGetComputeRunningProcesses_v3");
                name = Export<TextFn>("nvmlDeviceGetName"); driver = Export<DriverFn>("nvmlSystemGetDriverVersion");
                if (NativeLibrary.TryGetExport(library, "nvmlDeviceGetUUID", out IntPtr optional)) uuid = Marshal.GetDelegateForFunctionPointer<TextFn>(optional);
            }
            catch { Dispose(); throw; }
        }

        private uint Invoke(Func<uint> call)
        {
#if ZEB_NATIVE_TESTS
            Interlocked.Increment(ref owner.nativeCallsInFlight);
            try { return call(); }
            finally { Interlocked.Decrement(ref owner.nativeCallsInFlight); }
#else
            return call();
#endif
        }
        internal uint Init()
        {
#if ZEB_NATIVE_TESTS
            Interlocked.Increment(ref owner.initCalls);
            if (owner.fault is not null) return Invoke(() => 0);
#endif
            return Invoke(() => init!());
        }
        internal uint Shutdown()
        {
#if ZEB_NATIVE_TESTS
            Interlocked.Increment(ref owner.shutdownCalls);
            if (owner.fault is not null) return Invoke(() => 0);
#endif
            return Invoke(() => shutdown!());
        }
        internal uint Count(ref uint value)
        {
            uint local = value;
            uint status = Invoke(() =>
            {
#if ZEB_NATIVE_TESTS
                if (owner.fault is not null) { local = owner.fault == "NvmlMultiDevice" ? 3u : 1u; return 0; }
#endif
                return count!(ref local);
            });
            value = local; return status;
        }
        internal uint Handle(uint index, out IntPtr value)
        {
            IntPtr local = IntPtr.Zero;
            uint status = Invoke(() =>
            {
#if ZEB_NATIVE_TESTS
                if (owner.fault is not null) { local = new IntPtr(checked((int)index + 1)); return 0; }
#endif
                return handle!(index, out local);
            });
            value = local; return status;
        }
        internal uint Processes(IntPtr device, bool isGraphics, ref uint value, IntPtr values)
        {
            uint local = value;
#if ZEB_NATIVE_TESTS
            if (isGraphics) { if (values == IntPtr.Zero) Interlocked.Increment(ref owner.graphicsCountCalls); else Interlocked.Increment(ref owner.graphicsFillCalls); }
            else { if (values == IntPtr.Zero) Interlocked.Increment(ref owner.computeCountCalls); else Interlocked.Increment(ref owner.computeFillCalls); }
#endif
            uint status = Invoke(() =>
            {
#if ZEB_NATIVE_TESTS
                if (owner.fault is not null)
                {
                    uint answer = FixedProcesses(device, isGraphics, ref local, values);
                    if (isGraphics && (values != IntPtr.Zero || owner.fault == "NvmlPermission") && Interlocked.Exchange(ref owner.barrier, 1) == 0)
                        owner.bridge!.Reach("observation", "BeforeNativeReturn", owner.session);
                    return answer;
                }
#endif
                return (isGraphics ? graphics! : compute!)(device, ref local, values);
            });
            value = local; return status;
        }
        internal string Driver()
        {
            byte[] text = new byte[80];
            uint status = Invoke(() =>
            {
#if ZEB_NATIVE_TESTS
                if (owner.fault is not null) return FixedText(text, "580.97");
#endif
                return driver!(text, (uint)text.Length);
            });
            Check(status); return Decode(text);
        }
        internal string Name(IntPtr device)
        {
            byte[] text = new byte[96];
            uint status = Invoke(() =>
            {
#if ZEB_NATIVE_TESTS
                if (owner.fault is not null) return FixedText(text, owner.fault == "NvmlComputeOnly" || device.ToInt64() == 3
                    ? "Controlled compute context" : "Controlled graphics context");
#endif
                return name!(device, text, (uint)text.Length);
            });
            Check(status); return Decode(text);
        }
        internal string? Uuid(IntPtr device)
        {
#if ZEB_NATIVE_TESTS
            if (owner.fault is not null)
            {
                byte[] fixedText = new byte[96];
                if (owner.fault != "NvmlMultiDevice" || device.ToInt64() != 3) return null;
                Check(Invoke(() => FixedText(fixedText, "GPU-22222222-2222-2222-2222-222222222222")));
                return Decode(fixedText);
            }
#endif
            if (uuid is null) return null;
            byte[] text = new byte[96];
            if (Invoke(() => uuid(device, text, (uint)text.Length)) != 0) return null;
            try { return Decode(text); }
            catch (Exception failure) when (failure is ObservationFailure or DecoderFallbackException) { return null; }
        }

#if ZEB_NATIVE_TESTS
        private static uint FixedText(byte[] target, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            if (bytes.Length >= target.Length) return 7;
            bytes.CopyTo(target, 0); target[bytes.Length] = 0; return 0;
        }
        private uint FixedProcesses(IntPtr device, bool isGraphics, ref uint count, IntPtr values)
        {
            if (owner.fault == "NvmlPermission" && isGraphics) return 4;
            uint index = checked((uint)(device.ToInt64() - 1));
            bool match = isGraphics
                ? index == 0 && owner.fault is "NvmlGraphicsOnly" or "NvmlMultiDevice" or "NvmlBlockedReturn"
                : owner.fault == "NvmlComputeOnly" || (index == 2 && owner.fault == "NvmlMultiDevice");
            uint needed = match ? 2u : 1u;
            if (owner.fault == "NvmlFillIncomplete" && isGraphics)
            { count = values == IntPtr.Zero ? 1u : 2u; return 7; }
            if (values == IntPtr.Zero || count < needed) { count = needed; return 7; }
            uint foreign = pid == 1 ? 2u : 1u;
            for (uint row = 0; row < needed; row++)
            {
                IntPtr at = IntPtr.Add(values, checked((int)row * 24));
                Marshal.WriteInt32(at, 0, unchecked((int)(row == 0 && match ? pid : foreign)));
                Marshal.WriteInt32(at, 4, 0);
                Marshal.WriteInt64(at, 8, -1);
                Marshal.WriteInt32(at, 16, -1); Marshal.WriteInt32(at, 20, -1);
            }
            count = needed; return 0;
        }
#endif
        public void Dispose()
        {
            if (library == IntPtr.Zero) return;
            NativeLibrary.Free(library); library = IntPtr.Zero;
#if ZEB_NATIVE_TESTS
            Interlocked.Increment(ref owner.resourcesFreed);
#endif
        }
    }
}

internal sealed class NvmlProgress
{
    private readonly byte[] line = new byte[8];
    private int length;
    private bool discard, found;
    internal bool Consume(ReadOnlySpan<byte> bytes)
    {
        if (found) return false;
        foreach (byte value in bytes)
        {
            if (value != (byte)'\n')
            {
                if (length == line.Length) discard = true;
                else if (!discard) line[length++] = value;
                continue;
            }
            int end = length > 0 && line[length - 1] == (byte)'\r' ? length - 1 : length;
            bool valid = !discard && end is >= 5 and <= 7 && line[end - 1] == (byte)'%' && line[end - 4] == (byte)'.';
            int whole = 0;
            if (valid)
            {
                int digits = end - 4;
                valid = digits == 1 || line[0] != (byte)'0';
                for (int index = 0; index < digits; index++)
                {
                    valid &= line[index] is >= (byte)'0' and <= (byte)'9';
                    whole = whole * 10 + line[index] - (byte)'0';
                }
                valid &= line[end - 3] is >= (byte)'0' and <= (byte)'9' && line[end - 2] is >= (byte)'0' and <= (byte)'9';
                valid &= whole < 100 || whole == 100 && line[end - 3] == (byte)'0' && line[end - 2] == (byte)'0';
            }
            length = 0; discard = false;
            if (valid) { found = true; return true; }
        }
        return false;
    }
}
