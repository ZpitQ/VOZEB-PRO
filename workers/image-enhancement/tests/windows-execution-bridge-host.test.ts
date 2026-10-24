import { describe, expect, it } from "vitest";

import { decodeWindowsControlBridgeResponse } from "../src/windows-control-bridge-protocol.js";
import {
  controlBridgeBound,
  controlBridgeFrame,
  syntheticExecutionId,
} from "./windows-control-bridge-host-fixtures.js";

const target = {
  identity: {
    jobId: "execution-bridge-fixture-job",
    attemptNo: 1,
    ownerInstanceId: "execution-bridge-fixture-owner",
    fence: 1,
  },
  launchTicket: "execution-bridge-fixture-ticket",
};
const descriptor = {
  adapterId: "windows-supervisor-v1",
  launchTicket: target.launchTicket,
  executionId: syntheticExecutionId,
  details: {
    v: 1,
    target,
    executionPolicyFingerprint: "c".repeat(64),
    requestFingerprint: "d".repeat(64),
    requestRecordId: "00000000000000000000000000000001",
    preparedRecordId: "00000000000000000000000000000002",
    recipeId: "upscayl-4x-png-v1",
    installationManifestSha256: "b".repeat(64),
    supervisor: controlBridgeBound().helper,
    engine: { pid: 12_003, creationFileTime: "9007199254740995" },
    jobName: "execution-bridge-fixture-job-object",
  },
};

function prepared() {
  return {
    v: 1,
    kind: "state",
    requestId: "00000000000000000000000000000007",
    executionId: syntheticExecutionId,
    state: {
      phase: "prepared",
      sealReason: null,
      requestFingerprint: descriptor.details.requestFingerprint,
      descriptor: structuredClone(descriptor),
      authorizationVerified: false,
      resumeState: "not-attempted",
      evidenceOutcome: "pending",
      completion: null,
      runtimeObservation: null,
    },
  };
}

describe("execution bridge exact response decoder", () => {
  it("accepts the real prepared schema including descriptor target identity", () => {
    const frame = prepared();
    expect(
      decodeWindowsControlBridgeResponse(controlBridgeFrame(frame), 6),
    ).toEqual(frame);
  });

  it("accepts the exact nonterminal natural ending notification", () => {
    const frame = { v: 1, kind: "ending", executionId: syntheticExecutionId };
    expect(
      decodeWindowsControlBridgeResponse(controlBridgeFrame(frame), 6),
    ).toEqual(frame);
  });

  it.each([
    [
      "outer execution",
      (frame: ReturnType<typeof prepared>) => {
        frame.state.descriptor.executionId = "e".repeat(32);
      },
    ],
    [
      "outer fingerprint",
      (frame: ReturnType<typeof prepared>) => {
        frame.state.descriptor.details.requestFingerprint = "f".repeat(64);
      },
    ],
    [
      "launch ticket",
      (frame: ReturnType<typeof prepared>) => {
        frame.state.descriptor.launchTicket = "other-fixture-ticket";
      },
    ],
    [
      "record slot",
      (frame: ReturnType<typeof prepared>) => {
        frame.state.descriptor.details.preparedRecordId =
          "00000000000000000000000000000003";
      },
    ],
    [
      "UInt32 engine PID",
      (frame: ReturnType<typeof prepared>) => {
        frame.state.descriptor.details.engine.pid = 4_294_967_296;
      },
    ],
  ])("rejects a mismatched %s binding", (_name, change) => {
    const frame = prepared();
    change(frame);
    expect(() =>
      decodeWindowsControlBridgeResponse(controlBridgeFrame(frame), 6),
    ).toThrow();
  });

  it("keeps finite nested depth and duplicate-key rejection", () => {
    const frame = controlBridgeFrame(prepared());
    expect(() => decodeWindowsControlBridgeResponse(frame, 5)).toThrow();
    expect(() =>
      decodeWindowsControlBridgeResponse(
        Buffer.from(
          frame
            .toString("utf8")
            .replace('"attemptNo":1', '"attemptNo":1,"attemptNo":1'),
        ),
        6,
      ),
    ).toThrow();
  });
});
