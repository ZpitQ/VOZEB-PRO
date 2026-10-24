using System.Security.Principal;
using System.Text.Json;
using Zeb.WindowsServiceHost;

namespace Zeb.WindowsServiceHostFixture;

internal static partial class Program
{
    // Deliberately synthetic parser bytes; real Worker evidence belongs to the three Host-final cases.
    private static int RunStartupPhaseControls(string path)
    {
        string directory = Path.GetFullPath(path);
        Require(Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any(), "phase_controls_empty_directory");
        using var identity = WindowsIdentity.GetCurrent();
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        var caller = Native.Identity(new IntPtr(-1));
        string sid = identity.User?.Value ?? throw new InvalidDataException("phase_controls_actual_sid_missing");
        string attempt = Guid.NewGuid().ToString(), operation = Guid.NewGuid().ToString();
        string nonce = StartupHash("phase-controls-nonce"u8), hash = StartupFileHash(Executable);
        string context = JsonSerializer.Serialize(new {
            v = 1, operationId = operation, startupAttemptId = attempt, startingReceiptSha256 = StartupHash("phase-controls-receipt"u8),
            pipeName = "zeb-worker-startup-v1-" + attempt.Replace("-", ""), nonce,
            cutoffTick64 = checked(Environment.TickCount64 + 10_000),
            caller = new { caller.Pid, caller.CreationFileTime, imagePath = Executable, imageSha256 = hash,
                tokenUserSid = sid, sessionId = process.SessionId }, expectedServiceSid = sid,
            inventorySha256 = hash, configSha256 = hash, engineManifestSha256 = hash, hostSha256 = hash, nodeSha256 = hash
        }, Json);
        string encoded = Convert.ToBase64String(Utf8.GetBytes(context)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        const string prefix = "ZEB_WORKER_STARTUP_V1 ";
        string body = JsonSerializer.Serialize(new { v = 1, kind = "startup_phase", attempt, nonce, phase = "listening",
            runnerConstructed = true, listenerSucceeded = true, recoveryCalled = false,
            claimEntered = false, prepareEntered = false, authorizeEntered = false }, Json);
        byte[] Wire(string json) => Utf8.GetBytes(prefix + json + "\n");
        byte[] valid = Wire(body);
        Require(valid.Length < 512, "phase_controls_boundary_setup");
        byte[] exact = Utf8.GetBytes(prefix + body + new string(' ', 512 - valid.Length) + "\n");
        byte[] overlong = Utf8.GetBytes(prefix + body + new string(' ', 513 - valid.Length) + "\n");
        Require(exact.Length == 512 && overlong.Length == 513, "phase_controls_actual_wire_lengths");
        string wrongNonce = (nonce[0] == '0' ? "1" : "0") + nonce[1..];
        (string Name, bool Accepted, byte[][] Chunks)[] inputs = [
            ("valid-split-and-long-log", true, [Utf8.GetBytes("unrelated " + new string('x', 32_768) + "\n"),
                valid[..7], valid[7..37], valid[37..^1], valid[^1..], Utf8.GetBytes("unrelated tail\n")]),
            ("valid-512-boundary", true, [exact[..511], exact[511..]]),
            ("invalid-utf8", false, [[.. Utf8.GetBytes(prefix), 0xff, (byte)'\n']]),
            ("unknown-key", false, [Wire(body[..^1] + ",\"extra\":true}")]),
            ("duplicate-key", false, [Wire(body[..^1] + ",\"nonce\":\"" + nonce + "\"}")]),
            ("wrong-nonce", false, [Wire(body.Replace("\"nonce\":\"" + nonce + "\"", "\"nonce\":\"" + wrongNonce + "\"", StringComparison.Ordinal))]),
            ("wrong-attempt", false, [Wire(body.Replace("\"attempt\":\"" + attempt + "\"", "\"attempt\":\"" + Guid.NewGuid().ToString() + "\"", StringComparison.Ordinal))]),
            ("nonboolean", false, [Wire(body.Replace("\"claimEntered\":false", "\"claimEntered\":\"false\"", StringComparison.Ordinal))]),
            ("contradictory-listening-state", false, [Wire(body.Replace("\"runnerConstructed\":true", "\"runnerConstructed\":false", StringComparison.Ordinal))]),
            ("repeated-phase", false, [valid, valid]),
            ("over-512", false, [overlong]),
            ("no-phase-eof", false, [Utf8.GetBytes("ordinary log only\n")]),
            ("partial-phase-eof", false, [valid[..^1]]),
            ("valid-then-partial-phase-eof", false, [valid, valid[..^1]])
        ];
        var cases = new List<object>();
        bool passed = true;
        foreach (var input in inputs)
        {
            using var observation = StartupObservation.CreateForTechnicalFixture(encoded);
            foreach (byte[] chunk in input.Chunks) observation.ObserveStderr(chunk);
            Exception? beforeEof = observation.Capture.Failure;
            observation.CompleteStderr();
            Exception? first = observation.Capture.Failure;
            bool eofRetained = beforeEof is null || ReferenceEquals(beforeEof, first);
            bool missingAtEof = input.Name is "no-phase-eof" or "partial-phase-eof" or "valid-then-partial-phase-eof";
            bool failureTiming = (beforeEof is null) == (input.Accepted || missingAtEof);
            bool missingClassified = !missingAtEof || first is EndOfStreamException;
            if (!input.Accepted)
            {
                observation.ObserveStderr(valid);
                observation.CompleteStderr();
            }
            Exception? afterValid = observation.Capture.Failure;
            observation.Dispose();
            var retained = observation.Capture;
            bool failureRetained = ReferenceEquals(first, afterValid) && ReferenceEquals(first, retained.Failure);
            bool noFinalClaim = retained.FinalFrameBase64 is null && !retained.FinalWriteReturned && !retained.Disarmed;
            bool accepted = first is null;
            bool casePassed = accepted == input.Accepted && failureTiming && missingClassified && eofRetained && failureRetained && noFinalClaim;
            passed &= casePassed;
            cases.Add(new { input.Name, expectedAccepted = input.Accepted, accepted,
                chunkLengths = input.Chunks.Select(chunk => chunk.Length).ToArray(),
                beforeEofFailureType = beforeEof?.GetType().Name, failureType = first?.GetType().Name,
                failureTiming, missingClassified, eofRetained, failureRetained, noFinalClaim, passed = casePassed });
        }
        return WriteCase(directory, new { passed, cases, caseCount = inputs.Length,
            scope = "technical parser controls only; no Worker/pipe/SCM/ready/settled/FailureProof/Recover evidence" });
    }
}
