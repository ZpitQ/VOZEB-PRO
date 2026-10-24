import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const fixture = process.env.ZEB_WINDOWS_SESSION_FIXTURE_EXE;
const bridge = process.env.ZEB_WINDOWS_CONTROL_BRIDGE_EXE;
const suite = process.env.ZEB_RUN_WINDOWS_SESSION_OS === "1" ? describe : describe.skip;
const names = ["stdout-eof-before-owner", "no-permit", "caller-close", "request-expired",
  "owner-already-ended", "authorize-pending", "wrong-owner", "session-expired", "deadline-cancel", "write-not-invoked", "observer-unknown-before-owner"] as const;
type Row = { name: string; heldBeforeReply: boolean; observerBytesBeforeReply: number | null; frames: Record<string, unknown>[] };

suite("actual bridge assembly prepare diagnostic receiver controls", () => {
  let report: { rows: Row[] };
  beforeAll(async () => {
    expect(process.platform).toBe("win32");
    expect(fixture).toBeDefined();
    expect(bridge).toBeDefined();
    const assembly = join(dirname(bridge!), "WindowsControlBridge.dll");
    const before = createHash("sha256").update(await readFile(assembly)).digest("hex");
    const result = await promisify(execFile)(fixture!, ["bridge-prepare-diagnostic", assembly], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1_048_576,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.kind).toBe("bridge-prepare-diagnostic-controls");
    expect(parsed.assemblySha256).toBe(before);
    expect(createHash("sha256").update(await readFile(assembly)).digest("hex")).toBe(before);
    report = parsed;
    expect(report.rows.map((row) => row.name)).toEqual(names);
  }, 30_000);
  it.each(names)("%s reconciles only the current original prepare reply", (name) => {
      const row = report.rows.find((value) => value.name === name)!;
      expect(row, row.name).toMatchObject({ sealedSession: true, noEngineOrService: true, syntheticPendingOwner: true });
      expect(row.heldBeforeReply, row.name).toBe(["stdout-eof-before-owner", "caller-close", "deadline-cancel"].includes(row.name));
      const diagnostic = row.frames.filter((frame) => frame.prepareDiagnostic !== undefined);
      if (row.name === "observer-unknown-before-owner") expect(row.observerBytesBeforeReply).toBeGreaterThan(0);
      if (["stdout-eof-before-owner", "observer-unknown-before-owner"].includes(row.name)) {
        expect(diagnostic, row.name).toHaveLength(1);
        expect(diagnostic[0]).toMatchObject({ kind: "unknown", requestId: "b".repeat(32),
          prepareDiagnostic: { prepareStage: "installation_open", nativeStage: "file_open", nativeErrorCode: 5 } });
      } else expect(diagnostic, row.name).toEqual([]);
      expect(row.frames.filter((frame) => frame.kind === "unknown").length, row.name).toBeLessThanOrEqual(1);
  });
});
