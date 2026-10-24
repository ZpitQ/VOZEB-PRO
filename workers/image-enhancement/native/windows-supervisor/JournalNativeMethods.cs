using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Zeb.WindowsSupervisor;

internal sealed class JournalFailure(string stage, int? error = null) : Exception
{
    internal JournalDiagnostic Diagnostic { get; } = new(stage, error);
}

internal sealed record JournalFileIdentity(string VolumeSerial, string FileId);

[SupportedOSPlatform("windows")]
internal sealed class JournalRoot : IDisposable
{
    internal JournalRoot(List<SafeFileHandle> pins, string path, JournalFileIdentity identity, SecurityIdentifier user)
    {
        Pins = pins;
        Path = path;
        Identity = identity;
        User = user;
    }

    private List<SafeFileHandle> Pins { get; }
    internal SafeFileHandle Handle => Pins[^1];
    internal string Path { get; }
    internal JournalFileIdentity Identity { get; }
    internal SecurityIdentifier User { get; }
    internal string Child(string leaf) => Path + "\\" + leaf;

    public void Dispose()
    {
        for (int index = Pins.Count - 1; index >= 0; index--) Pins[index].Dispose();
    }
}

[SupportedOSPlatform("windows")]
internal static class JournalNativeMethods
{
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint Delete = 0x00010000;
    private const uint ReadControl = 0x00020000;
    private const uint Synchronize = 0x00100000;
    private const uint ReadAttributes = 0x80;
    private const uint ShareRead = 1;
    private const uint ShareWrite = 2;
    private const uint ShareDelete = 4;
    private const uint BackupAndOpenReparse = 0x02200000;
    private const int FileFullControl = 0x001f01ff;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileStandard
    {
        internal long AllocationSize, EndOfFile;
        internal uint Links;
        [MarshalAs(UnmanagedType.U1)] internal bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] internal bool Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTag
    {
        internal uint Attributes, ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileRenameInformation
    {
        internal byte ReplaceIfExists;
        internal IntPtr RootDirectory;
        internal uint FileNameLength;
        internal ushort FileName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        internal IntPtr StatusOrPointer;
        internal UIntPtr Information;
    }

    internal static JournalRoot PinRoot(string recordsRoot)
    {
        string full;
        try
        {
            if (!System.IO.Path.IsPathFullyQualified(recordsRoot)) throw new JournalFailure("root_path");
            full = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(recordsRoot));
        }
        catch (JournalFailure) { throw; }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or IOException)
        {
            throw new JournalFailure("root_path");
        }
        if (full.Length < 3 || !char.IsAsciiLetter(full[0]) || full[1] != ':' || full[2] != '\\' ||
            full.AsSpan(2).Contains(':')) throw new JournalFailure("root_path");

        using var identity = WindowsIdentity.GetCurrent();
        SecurityIdentifier user = identity.User ?? throw new JournalFailure("current_user");
        var pins = new List<SafeFileHandle>();
        try
        {
            string drive = full[..3];
            var components = full[3..].Split('\\', StringSplitOptions.RemoveEmptyEntries);
            string current = drive;
            for (int index = -1; index < components.Length; index++)
            {
                if (index >= 0)
                {
                    string component = components[index];
                    if (component is "." or ".." || component.EndsWith(' ') || component.EndsWith('.'))
                        throw new JournalFailure("root_path");
                    current = System.IO.Path.Combine(current, component);
                }
                bool isRoot = index == components.Length - 1;
                SafeFileHandle pin = OpenDirectory(current, isRoot ? ShareRead : ShareRead | ShareWrite,
                    isRoot ? ReadControl | ReadAttributes | Synchronize | 1 : ReadAttributes | Synchronize);
                pins.Add(pin);
                RequireDirectory(pin);
                string actual = FinalPath(pin);
                string volumeRoot = RequireGuidVolume(actual);
                if (GetDriveTypeW(volumeRoot) != 3) throw new JournalFailure("volume_not_fixed");
                if (index == -1 && !SamePath(actual, volumeRoot)) throw new JournalFailure("volume_mapping");
                if (index >= 0)
                {
                    string previous = FinalPath(pins[^2]);
                    if (!SamePath(System.IO.Path.GetDirectoryName(actual), previous))
                        throw new JournalFailure("ancestor_identity");
                }
            }
            SafeFileHandle root = pins[^1];
            RequireNtfs(root);
            RequireSecurity(root, user);
            return new JournalRoot(pins, FinalPath(root).TrimEnd('\\'), Identity(root), user);
        }
        catch
        {
            for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
            throw;
        }
    }

    private static SafeFileHandle OpenDirectory(string path, uint share, uint access)
    {
        SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, 3, BackupAndOpenReparse, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new JournalFailure("directory_open", error);
        }
        return handle;
    }

    internal static void ValidateInstallationAncestors(string programRoot, string dataRoot)
    {
        var pins = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (string path in new[] { programRoot, dataRoot })
            {
                if (!System.IO.Path.IsPathFullyQualified(path)) throw new JournalFailure("root_path");
                string full = System.IO.Path.TrimEndingDirectorySeparator(System.IO.Path.GetFullPath(path));
                if (full.Length <= 3 || !char.IsAsciiLetter(full[0]) || full[1] != ':' || full[2] != '\\' ||
                    full.AsSpan(2).Contains(':')) throw new JournalFailure("root_path");
                string current = full[..3];
                string? previous = null;
                var components = full[3..].Split('\\', StringSplitOptions.RemoveEmptyEntries);
                for (int index = -1; index < components.Length; index++)
                {
                    if (index >= 0)
                    {
                        string component = components[index];
                        if (component is "." or ".." || component.EndsWith(' ') || component.EndsWith('.'))
                            throw new JournalFailure("root_path");
                        current = System.IO.Path.Combine(current, component);
                    }
                    if (!pins.TryGetValue(current, out var pin))
                    {
                        pin = OpenDirectory(current, ShareRead | ShareWrite, ReadAttributes | Synchronize | 0x20);
                        pins.Add(current, pin);
                    }
                    RequireDirectory(pin);
                    string actual = FinalPath(pin);
                    if (index == -1)
                    {
                        string volume = RequireGuidVolume(actual);
                        if (!SamePath(actual, volume)) throw new JournalFailure("volume_mapping");
                        RequireNtfs(pin);
                    }
                    else if (!SamePath(System.IO.Path.GetDirectoryName(actual), previous))
                        throw new JournalFailure("ancestor_identity");
                    previous = actual;
                }
            }
        }
        finally
        {
            foreach (var pin in pins.Values.Reverse()) pin.Dispose();
        }
    }

    internal static SafeFileHandle? CreateNew(JournalRoot root, string leaf, out int error)
    {
        var acl = new RawAcl(GenericAcl.AclRevision, 1);
        acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, FileFullControl, root.User, false, null));
        var descriptor = new RawSecurityDescriptor(ControlFlags.SelfRelative | ControlFlags.DiscretionaryAclPresent |
            ControlFlags.DiscretionaryAclProtected, root.User, null, null, acl);
        byte[] binary = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(binary, 0);
        GCHandle pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
        SafeFileHandle handle;
        try
        {
            var security = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = pinned.AddrOfPinnedObject(), Inherit = false,
            };
            handle = CreateFileW(root.Child(leaf), GenericRead | GenericWrite | Delete, ShareRead,
                ref security, 1, BackupAndOpenReparse, IntPtr.Zero);
            error = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
        finally { pinned.Free(); }
        if (handle.IsInvalid)
        {
            handle.Dispose();
            return null;
        }
        try
        {
            RequireFile(handle, root);
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    internal static SafeFileHandle OpenRead(JournalRoot root, string leaf, bool ownerCompatible)
        => OpenReadPath(root, root.Child(leaf), ownerCompatible);

    private static SafeFileHandle OpenReadPath(JournalRoot root, string path, bool ownerCompatible)
    {
        SafeFileHandle handle = CreateFileW(path, GenericRead, ownerCompatible ? 7u : ShareRead,
            IntPtr.Zero, 3, BackupAndOpenReparse, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new JournalFailure("file_open", error);
        }
        try { RequireFile(handle, root); return handle; }
        catch { handle.Dispose(); throw; }
    }

    internal static SafeFileHandle OpenReadBoundAlias(JournalRoot root, SafeFileHandle original, string path)
    {
        SafeFileHandle handle = OpenReadPath(root, path, false);
        try
        {
            if (!SamePath(FinalPath(handle), FinalPath(original)) || Identity(handle) != Identity(original) ||
                RequireFile(handle, root) != RequireFile(original, root))
                throw new JournalFailure("file_identity");
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

#if ZEB_NATIVE_TESTS
    internal static SafeFileHandle OpenReadOnlySameObject(JournalRoot root, SafeFileHandle original)
    {
        string actual = FinalPath(original);
        if (!SamePath(System.IO.Path.GetDirectoryName(actual), root.Path)) throw new JournalFailure("source_parent");
        var handle = OpenRead(root, System.IO.Path.GetFileName(actual), true);
        if (Identity(handle) == Identity(original)) return handle;
        handle.Dispose();
        throw new JournalFailure("io_identity");
    }
#endif

    internal static bool HasPriorHistory(JournalRoot root, string key)
    {
        string marker = key + ".reserved";
        return Directory.EnumerateFileSystemEntries(root.Path)
            .Select(System.IO.Path.GetFileName)
            .Any(leaf => leaf is not null && leaf.StartsWith(key + ".", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(leaf, marker, StringComparison.OrdinalIgnoreCase));
    }

    internal static JournalFileIdentity Identity(SafeFileHandle handle)
    {
        const int bytes = 24;
        IntPtr memory = Marshal.AllocHGlobal(bytes);
        try
        {
            Check(GetFileInformationByHandleEx(handle, 18, memory, bytes), "file_identity");
            ulong volume = unchecked((ulong)Marshal.ReadInt64(memory));
            byte[] id = new byte[16];
            Marshal.Copy(IntPtr.Add(memory, 8), id, 0, id.Length);
            return new(volume.ToString(CultureInfo.InvariantCulture), Convert.ToHexStringLower(id));
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    internal static void RequireRoot(JournalRoot root)
    {
        using var current = WindowsIdentity.GetCurrent();
        if (current.User is not { } currentUser || !root.User.Equals(currentUser)) throw new JournalFailure("current_user");
        RequireDirectory(root.Handle);
        RequireSecurity(root.Handle, root.User);
        if (Identity(root.Handle) != root.Identity || !SamePath(FinalPath(root.Handle), root.Path))
            throw new JournalFailure("root_identity");
    }

    internal static long RequireFile(SafeFileHandle handle, JournalRoot root)
    {
        RequireOrdinary(handle, false);
        RequireSecurity(handle, root.User);
        FileStandard standard = Standard(handle);
        if (standard.Links != 1 || Identity(handle).VolumeSerial != root.Identity.VolumeSerial ||
            !SamePath(System.IO.Path.GetDirectoryName(FinalPath(handle)), root.Path))
            throw new JournalFailure("file_identity");
        return standard.EndOfFile;
    }

    private static void RequireDirectory(SafeFileHandle handle) => RequireOrdinary(handle, true);

    private static void RequireOrdinary(SafeFileHandle handle, bool directory)
    {
        try { ControlNativeMethods.RequireNoninherited(handle); }
        catch (Win32Exception error) { throw new JournalFailure("handle_noninheritance", error.NativeErrorCode); }
        catch (InvalidOperationException) { throw new JournalFailure("handle_noninheritance"); }
        uint type = GetFileType(handle);
        if (type != 1) throw new JournalFailure("file_type", type == 0 ? Marshal.GetLastWin32Error() : null);
        Check(GetFileInformationByHandleEx(handle, 9, out FileAttributeTag tag, (uint)Marshal.SizeOf<FileAttributeTag>()), "file_attributes");
        FileStandard standard = Standard(handle);
        if ((tag.Attributes & 0x400) != 0 || standard.DeletePending || standard.Directory != directory || standard.EndOfFile < 0)
            throw new JournalFailure("file_ordinary");
    }

    private static FileStandard Standard(SafeFileHandle handle)
    {
        Check(GetFileInformationByHandleEx(handle, 1, out FileStandard standard, (uint)Marshal.SizeOf<FileStandard>()), "file_standard");
        return standard;
    }

    private static void RequireSecurity(SafeFileHandle handle, SecurityIdentifier user)
    {
        uint error = GetSecurityInfo(handle, 1, 5, out _, out _, out _, out _, out IntPtr descriptor);
        if (error != 0) throw new JournalFailure("file_security", unchecked((int)error));
        try
        {
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length == 0) throw new JournalFailure("file_security");
            byte[] binary = new byte[checked((int)length)];
            Marshal.Copy(descriptor, binary, 0, binary.Length);
            var actual = new RawSecurityDescriptor(binary, 0);
            const ControlFlags required = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected;
            if (actual.Owner is not { } owner || !user.Equals(owner) || (actual.ControlFlags & required) != required ||
                actual.DiscretionaryAcl is not { Count: 1 } dacl || dacl[0] is not CommonAce ace ||
                ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None || ace.IsCallback ||
                ace.AccessMask != FileFullControl || !user.Equals(ace.SecurityIdentifier))
                throw new JournalFailure("file_security");
        }
        finally { LocalFree(descriptor); }
    }

    private static void RequireNtfs(SafeFileHandle root)
    {
        var filesystem = new StringBuilder(261);
        Check(GetVolumeInformationByHandleW(root, IntPtr.Zero, 0, out _, out _, out uint flags,
            filesystem, (uint)filesystem.Capacity), "volume_information");
        if (filesystem.ToString() != "NTFS" || (flags & 8) == 0) throw new JournalFailure("volume_ntfs_acl");
        if (GetDriveTypeW(RequireGuidVolume(FinalPath(root))) != 3) throw new JournalFailure("volume_not_fixed");
    }

    private static string RequireGuidVolume(string actual)
    {
        const string prefix = @"\\?\Volume{";
        int end = actual.IndexOf(@"}\", StringComparison.Ordinal);
        if (!actual.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || end < prefix.Length ||
            !Guid.TryParse(actual[prefix.Length..end], out _)) throw new JournalFailure("volume_mapping");
        return actual[..(end + 2)];
    }

    internal static string FinalPath(SafeFileHandle handle)
    {
        uint length = GetFinalPathNameByHandleW(handle, null, 0, 1);
        if (length == 0) throw new JournalFailure("final_path", Marshal.GetLastWin32Error());
        var buffer = new StringBuilder(checked((int)length + 1));
        uint actual = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 1);
        if (actual == 0) throw new JournalFailure("final_path", Marshal.GetLastWin32Error());
        if (actual >= buffer.Capacity) throw new JournalFailure("final_path");
        string path = buffer.ToString();
        RequireGuidVolume(path);
        return path;
    }

    private static bool SamePath(string? left, string? right) => left is not null && right is not null &&
        string.Equals(left.TrimEnd('\\'), right.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    internal static void Write(SafeFileHandle handle, byte[] bytes)
    {
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            int offset = 0;
            while (offset < bytes.Length)
            {
                Check(WriteFile(handle, IntPtr.Add(pinned.AddrOfPinnedObject(), offset), checked((uint)(bytes.Length - offset)),
                    out uint written, IntPtr.Zero), "file_write");
                if (written == 0 || written > bytes.Length - offset) throw new JournalFailure("file_write_incomplete");
                offset = checked(offset + (int)written);
            }
        }
        finally { pinned.Free(); }
    }

    internal static void Flush(SafeFileHandle handle) => Check(FlushFileBuffers(handle), "file_flush");

    internal static byte[] Read(SafeFileHandle handle)
    {
        long length = Standard(handle).EndOfFile;
        byte[] bytes = new byte[checked((int)length)];
        int offset = 0;
        while (offset < bytes.Length)
        {
            int count = RandomAccess.Read(handle, bytes.AsSpan(offset), offset);
            if (count == 0) throw new JournalFailure("file_read_incomplete");
            offset = checked(offset + count);
        }
        if (Standard(handle).EndOfFile != length) throw new JournalFailure("file_read_changed");
        return bytes;
    }

    internal static void Rename(JournalRoot root, SafeFileHandle source, string leaf)
    {
        // RootDirectory=NULL with a simple leaf resolves against this held
        // source's actual parent, not the process current directory.
        string before = FinalPath(source);
        string parentPath = System.IO.Path.GetDirectoryName(before) ?? throw new JournalFailure("source_parent");
        using SafeFileHandle parent = OpenDirectory(parentPath, ShareRead, ReadControl | ReadAttributes | Synchronize);
        RequireDirectory(parent);
        RequireSecurity(parent, root.User);
        if (Identity(parent) != root.Identity || !SamePath(FinalPath(parent), root.Path))
            throw new JournalFailure("source_parent");
        RequireRoot(root);
        if (leaf.Length == 0 || leaf.IndexOfAny(['\\', '/', ':', '\0']) >= 0 || leaf is "." or "..")
            throw new JournalFailure("rename_leaf");
        int rootOffset = checked((int)Marshal.OffsetOf<FileRenameInformation>(nameof(FileRenameInformation.RootDirectory)));
        int lengthOffset = checked((int)Marshal.OffsetOf<FileRenameInformation>(nameof(FileRenameInformation.FileNameLength)));
        int nameOffset = checked((int)Marshal.OffsetOf<FileRenameInformation>(nameof(FileRenameInformation.FileName)));
        int header = Marshal.SizeOf<FileRenameInformation>();
        if (IntPtr.Size != 8 || rootOffset != 8 || lengthOffset != 16 || nameOffset != 20 || header != 24 ||
            Marshal.SizeOf<IoStatusBlock>() != 16) throw new JournalFailure("rename_layout");
        byte[] name = Encoding.Unicode.GetBytes(leaf);
        int size = checked(header + name.Length);
        IntPtr information = Marshal.AllocHGlobal(size);
        IntPtr ioStatus = Marshal.AllocHGlobal(Marshal.SizeOf<IoStatusBlock>());
        bool sourceLease = false, rootLease = false, parentLease = false;
        bool release = true;
        try
        {
            source.DangerousAddRef(ref sourceLease);
            root.Handle.DangerousAddRef(ref rootLease);
            parent.DangerousAddRef(ref parentLease);
            Marshal.Copy(new byte[size], 0, information, size);
            Marshal.Copy(new byte[Marshal.SizeOf<IoStatusBlock>()], 0, ioStatus, Marshal.SizeOf<IoStatusBlock>());
            Marshal.WriteIntPtr(information, rootOffset, IntPtr.Zero);
            Marshal.WriteInt32(information, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
            int status = NtSetInformationFile(source, ioStatus, information, checked((uint)size), 10);
            if (status == 0x103)
            {
                uint wait = WaitForSingleObject(source, uint.MaxValue);
                if (wait != 0)
                {
                    // Completion is not proven. The kernel may still refer to
                    // both buffers, so retain them and the actual pins until
                    // process exit rather than freeing active I/O storage.
                    release = false;
                    throw new JournalFailure("rename_wait", wait == uint.MaxValue ? Marshal.GetLastWin32Error() : null);
                }
                status = Marshal.ReadInt32(ioStatus);
                if (status == 0x103)
                {
                    release = false;
                    throw new JournalFailure("rename_completion", unchecked((int)RtlNtStatusToDosError(status)));
                }
            }
            if (status != 0) throw new JournalFailure("file_rename", unchecked((int)RtlNtStatusToDosError(status)));
            string after = FinalPath(source);
            if (!SamePath(System.IO.Path.GetDirectoryName(after), root.Path) ||
                !string.Equals(System.IO.Path.GetFileName(after), leaf, StringComparison.Ordinal))
                throw new JournalFailure("renamed_identity");
        }
        finally
        {
            if (release)
            {
                Marshal.FreeHGlobal(ioStatus);
                Marshal.FreeHGlobal(information);
                if (parentLease) parent.DangerousRelease();
                if (rootLease) root.Handle.DangerousRelease();
                if (sourceLease) source.DangerousRelease();
            }
        }
    }

    private static void Check(bool success, string stage)
    {
        if (!success) throw new JournalFailure(stage, Marshal.GetLastWin32Error());
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, IntPtr information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileStandard information, uint bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out FileAttributeTag information, uint bytes);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, IntPtr name, uint nameLength, out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder filesystem, uint filesystemLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder? path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(SafeFileHandle handle, IntPtr bytes, uint length, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("ntdll.dll")]
    private static extern int NtSetInformationFile(SafeFileHandle handle, IntPtr ioStatus, IntPtr information, uint bytes, int informationClass);
    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
}

// Expose one read-only startup check without exposing the journal's handles or its stricter leaf-owner contract.
[SupportedOSPlatform("windows")]
public static class InstallationAncestorAccess
{
    public static void Validate(string programRoot, string dataRoot) =>
        JournalNativeMethods.ValidateInstallationAncestors(programRoot, dataRoot);
}
