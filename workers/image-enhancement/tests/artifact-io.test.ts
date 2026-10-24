import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localArtifactFiles, type ArtifactWork } from "../src/artifacts.js";
import {
  artifactFixture,
  nativePng,
  reachedBeforeSettled,
  writeActualFile,
  type ArtifactFileEvent,
  type ArtifactFixture,
} from "./artifact-fixtures.js";
import {
  artifactJobRows,
  assertCandidateFiles,
  assertIntentAndReference,
  publishedArtifactControl,
  trustedArtifactAncestors,
} from "./artifact-fault-fixtures.js";
import { sha256, sourceImage, submission } from "./storage-fixtures.js";

const fixtures: ArtifactFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0).reverse()) await f.cleanup();
});
async function fixture() {
  const f = await artifactFixture();
  fixtures.push(f);
  return f;
}

type Events = ArtifactFixture["events"];
function completed(
  events: Events,
  path: string,
  stage: ArtifactFileEvent["stage"],
) {
  return events.findIndex(
    (item) =>
      item.phase === "after" &&
      item.event.path === path &&
      item.event.stage === stage,
  );
}
function assertRenamedBeforeSync(
  events: Events,
  work: ArtifactWork,
  path: string,
) {
  assert.ok(work.candidate);
  const artifactRename = completed(
    events,
    work.candidate.pngPartPath,
    "rename",
  );
  const manifestRename = completed(
    events,
    work.candidate.manifestPartPath,
    "rename",
  );
  const sync = completed(events, path, "directory_sync");
  assert.ok(artifactRename >= 0, "the artifact rename must really complete");
  assert.ok(
    manifestRename > artifactRename,
    "the manifest rename must really complete",
  );
  assert.ok(
    sync > manifestRename,
    "the selected real directory sync must follow both renames",
  );
}
async function closedCode(event: ArtifactFileEvent) {
  assert.ok(event.file);
  try {
    await event.file.stat();
    return undefined;
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  }
}
function expectBlockedIntent(
  f: ArtifactFixture,
  work: ArtifactWork,
  stage: string,
) {
  const rows = artifactJobRows(f, work.key.publisher.jobId);
  assertIntentAndReference(rows, work);
  expect(rows.observations).toEqual([
    expect.objectContaining({
      reference_id: work.key.referenceId,
      candidate_id: work.candidate?.candidateId,
      code: "io_failure",
      stage,
    }),
  ]);
  expect(f.storage.store.readArtifactWork(work.key)).toMatchObject({
    kind: "active",
    work: {
      key: work.key,
      candidate: { state: "intent" },
      observations: [
        { code: "io_failure", stage, candidateId: work.candidate?.candidateId },
      ],
    },
  });
  expect(f.storage.store.claimNext("must-not-recompute")).toBeUndefined();
}

const fileFaults = [
  {
    role: "artifact-part",
    stage: "write",
    phase: "before",
    fault: "partial write",
  },
  {
    role: "manifest-part",
    stage: "write",
    phase: "before",
    fault: "partial write",
  },
  {
    role: "artifact-part",
    stage: "file_sync",
    phase: "before",
    fault: "file sync",
  },
  {
    role: "manifest-part",
    stage: "file_sync",
    phase: "before",
    fault: "file sync",
  },
  {
    role: "artifact-part",
    stage: "close",
    phase: "after",
    fault: "closed handle acknowledgement",
  },
  {
    role: "manifest-part",
    stage: "close",
    phase: "after",
    fault: "closed handle acknowledgement",
  },
  {
    role: "artifact-part",
    stage: "rename",
    phase: "before",
    fault: "rename after write sync close",
  },
  {
    role: "manifest-part",
    stage: "rename",
    phase: "before",
    fault: "rename after write sync close",
  },
] as const;

const directoryFaults = [
  { label: "candidate directory", level: 0 },
  { label: "artifacts parent", level: 1 },
  { label: "working directory", level: 2 },
] as const;
function candidateSyncDirectories(work: ArtifactWork) {
  assert.ok(work.candidate);
  return [
    work.candidate.directory,
    dirname(work.candidate.directory),
    dirname(dirname(work.candidate.directory)),
  ];
}

// Register one independent test per actual ancestor. The topology is obtained
// from a real claim, rather than duplicating the store's path layout or depth.
const topology = await artifactFixture();
const ancestorFaults = await (async () => {
  try {
    const attempt = await topology.claim();
    return trustedArtifactAncestors(
      attempt.workingDirectory,
      topology.storage.directory,
    )
      .slice(1)
      .map((_path, index) => ({ ordinal: index + 1 }));
  } finally {
    await topology.cleanup();
  }
})();

describe("artifact real file operation faults", () => {
  it.each(fileFaults)(
    "retains intent after $role $fault fault",
    async ({ role, stage, phase }) => {
      const f = await fixture();
      const control = await publishedArtifactControl(
        f,
        `control-${role}-${stage}`,
      );
      const controlRows = artifactJobRows(f, control.attempt.identity.jobId);
      assert.ok(control.work.candidate);
      const controlPath =
        role === "artifact-part"
          ? control.work.candidate.pngPartPath
          : control.work.candidate.manifestPartPath;
      expect(
        completed(control.events, controlPath, stage),
      ).toBeGreaterThanOrEqual(0);

      const attempt = await f.claim(
        submission(await sourceImage(), `fault-${role}-${stage}`),
      );
      const png = await nativePng(attempt);
      await f.complete(attempt, png);
      const firstEvent = f.events.length;
      let hit = false;
      let reached:
        | {
            event: ArtifactFileEvent;
            work: ArtifactWork;
            rows: ReturnType<typeof artifactJobRows>;
            contents: Buffer;
            events: Events;
            partialBytes?: number;
            closed?: unknown;
          }
        | undefined;
      const previous = f.hooks[phase];
      f.hooks[phase] = async (event) => {
        await previous?.(event);
        if (hit || event.role !== role || event.stage !== stage) return;
        hit = true;
        const work = f.currentWork();
        assert.ok(work.candidate);
        let partialBytes: number | undefined;
        if (stage === "write") {
          assert.ok(event.file && event.buffer);
          assert.ok(event.length !== undefined && event.length > 1);
          assert.ok(event.offset !== undefined && event.position !== undefined);
          const partial = await event.file.write(
            event.buffer,
            event.offset,
            Math.max(1, Math.floor(event.length / 2)),
            event.position,
          );
          partialBytes = partial.bytesWritten;
        }
        reached = {
          event,
          work,
          rows: artifactJobRows(f, attempt.identity.jobId),
          contents: await readFile(event.path),
          events: f.events.slice(firstEvent),
          partialBytes,
          closed: stage === "close" ? await closedCode(event) : undefined,
        };
        throw new Error("controlled-artifact-file-fault");
      };
      await expect(f.settle(attempt)).resolves.toBe("blocked");
      expect(hit).toBe(true);
      assert.ok(reached, "the selected real file operation must be reached");
      const { work } = reached;
      assert.ok(work.candidate);
      assertIntentAndReference(reached.rows, work);
      const expected =
        role === "artifact-part"
          ? png
          : Buffer.from(JSON.stringify(work.candidate.manifest), "utf8");
      if (stage === "write") {
        expect(reached.event.position).toBe(0);
        expect(reached.partialBytes).toBeGreaterThan(0);
        expect(reached.partialBytes).toBeLessThan(expected.length);
        expect(reached.contents).toEqual(
          expected.subarray(0, reached.partialBytes),
        );
        expect(completed(reached.events, reached.event.path, "file_sync")).toBe(
          -1,
        );
      } else {
        expect(reached.contents).toEqual(expected);
        expect(
          completed(reached.events, reached.event.path, "write"),
        ).toBeGreaterThanOrEqual(0);
      }
      if (role === "manifest-part") {
        const artifactPath =
          stage === "rename"
            ? work.candidate.pngPath
            : work.candidate.pngPartPath;
        expect(await readFile(artifactPath)).toEqual(png);
        const write = completed(
          reached.events,
          work.candidate.pngPartPath,
          "write",
        );
        const sync = completed(
          reached.events,
          work.candidate.pngPartPath,
          "file_sync",
        );
        const close = completed(
          reached.events,
          work.candidate.pngPartPath,
          "close",
        );
        expect(write).toBeGreaterThanOrEqual(0);
        expect(sync).toBeGreaterThan(write);
        expect(close).toBeGreaterThan(sync);
        const closed = reached.events[close]?.event;
        assert.ok(closed);
        expect(await closedCode(closed)).toBe("EBADF");
      }
      if (stage === "file_sync") {
        expect(completed(reached.events, reached.event.path, "file_sync")).toBe(
          -1,
        );
      }
      if (stage === "close") {
        expect(
          completed(reached.events, reached.event.path, "file_sync"),
        ).toBeGreaterThanOrEqual(0);
        expect(
          completed(reached.events, reached.event.path, "close"),
        ).toBeGreaterThanOrEqual(0);
        expect(reached.closed).toBe("EBADF");
      }
      if (stage === "rename") {
        for (const path of [
          work.candidate.pngPartPath,
          work.candidate.manifestPartPath,
        ]) {
          const write = completed(reached.events, path, "write");
          const sync = completed(reached.events, path, "file_sync");
          const close = completed(reached.events, path, "close");
          expect(write).toBeGreaterThanOrEqual(0);
          expect(sync).toBeGreaterThan(write);
          expect(close).toBeGreaterThan(sync);
          const closed = reached.events[close]?.event;
          assert.ok(closed);
          expect(await closedCode(closed)).toBe("EBADF");
        }
        expect(completed(reached.events, reached.event.path, "rename")).toBe(
          -1,
        );
        if (role === "manifest-part") {
          expect(
            completed(reached.events, work.candidate.pngPartPath, "rename"),
          ).toBeGreaterThanOrEqual(0);
          expect(await readFile(work.candidate.pngPath)).toEqual(png);
        }
      }
      await expect(
        stat(
          role === "artifact-part"
            ? work.candidate.pngPath
            : work.candidate.manifestPath,
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expectBlockedIntent(f, work, stage);
      expect(artifactJobRows(f, control.attempt.identity.jobId)).toEqual(
        controlRows,
      );
      await assertCandidateFiles(control.work.candidate, control.png);
    },
  );

  it.each(directoryFaults)(
    "retains renamed intent when $label sync fails",
    async ({ level, label }) => {
      const f = await fixture();
      const control = await publishedArtifactControl(
        f,
        `control-directory-${level}`,
      );
      const controlDirectory = candidateSyncDirectories(control.work)[level];
      assert.ok(controlDirectory);
      assertRenamedBeforeSync(control.events, control.work, controlDirectory);

      const attempt = await f.claim(
        submission(await sourceImage(), `fault-directory-${level}`),
      );
      const png = await nativePng(attempt);
      await f.complete(attempt, png);
      const firstEvent = f.events.length;
      let reached:
        | {
            work: ArtifactWork;
            rows: ReturnType<typeof artifactJobRows>;
            events: Events;
          }
        | undefined;
      const previous = f.hooks.before;
      f.hooks.before = async (event) => {
        await previous?.(event);
        if (reached || event.stage !== "directory_sync") return;
        const work = f.currentWork();
        const paths = candidateSyncDirectories(work);
        if (event.path !== paths[level]) return;
        reached = {
          work,
          rows: artifactJobRows(f, attempt.identity.jobId),
          events: f.events.slice(firstEvent),
        };
        throw new Error(`controlled-${label}-sync-fault`);
      };
      await expect(f.settle(attempt)).resolves.toBe("blocked");
      assert.ok(
        reached,
        "the selected directory sync must be called after real renames",
      );
      const { work } = reached;
      assert.ok(work.candidate);
      assertIntentAndReference(reached.rows, work);
      await assertCandidateFiles(work.candidate, png);
      const paths = candidateSyncDirectories(work);
      const artifactRename = completed(
        reached.events,
        work.candidate.pngPartPath,
        "rename",
      );
      const manifestRename = completed(
        reached.events,
        work.candidate.manifestPartPath,
        "rename",
      );
      expect(artifactRename).toBeGreaterThanOrEqual(0);
      expect(manifestRename).toBeGreaterThan(artifactRename);
      for (const path of paths.slice(0, level))
        assertRenamedBeforeSync(reached.events, work, path);
      const selected = paths[level];
      assert.ok(selected);
      expect(completed(reached.events, selected, "directory_sync")).toBe(-1);
      expectBlockedIntent(f, work, "directory_sync");
      await assertCandidateFiles(control.work.candidate!, control.png);
    },
  );

  it.each(ancestorFaults)(
    "retains intent after trusted ancestor $ordinal sync acknowledgement fails",
    async ({ ordinal }) => {
      const f = await fixture();
      const control = await publishedArtifactControl(
        f,
        `control-ancestor-${ordinal}`,
      );
      const attempt = await f.claim(
        submission(await sourceImage(), `fault-ancestor-${ordinal}`),
      );
      const png = await nativePng(attempt);
      await f.complete(attempt, png);
      const ancestors = trustedArtifactAncestors(
        attempt.workingDirectory,
        f.storage.directory,
      );
      const selected = ancestors[ordinal];
      assert.ok(selected);
      const firstEvent = f.events.length;
      const gate = f.gate(
        (event) =>
          event.stage === "directory_sync" && resolve(event.path) === selected,
      );
      const previous = f.hooks.after;
      let faulted = false;
      f.hooks.after = async (event) => {
        await previous?.(event);
        if (
          !faulted &&
          event.stage === "directory_sync" &&
          resolve(event.path) === selected
        ) {
          faulted = true;
          throw new Error(
            "controlled-trusted-ancestor-sync-acknowledgement-fault",
          );
        }
      };
      const pending = f.settle(attempt);
      await reachedBeforeSettled(gate, pending);
      const work = f.currentWork();
      assert.ok(work.candidate);
      assertIntentAndReference(
        artifactJobRows(f, attempt.identity.jobId),
        work,
      );
      await assertCandidateFiles(work.candidate, png);
      const events = f.events.slice(firstEvent);
      for (const path of candidateSyncDirectories(work))
        assertRenamedBeforeSync(events, work, path);
      for (const path of ancestors.slice(1, ordinal + 1))
        assertRenamedBeforeSync(events, work, path);
      gate.release();
      await expect(pending).resolves.toBe("blocked");
      expect(faulted).toBe(true);
      expectBlockedIntent(f, work, "directory_sync");
      // The control reaches the complete chain in this exact environment. The
      // failure above cannot be satisfied by success before an ancestor is synced.
      for (const path of trustedArtifactAncestors(
        control.attempt.workingDirectory,
        f.storage.directory,
      )) {
        assertRenamedBeforeSync(control.events, control.work, path);
      }
      await assertCandidateFiles(control.work.candidate!, control.png);
    },
  );

  it("preserves an existing candidate directory and sentinel after real exclusive mkdir EEXIST", async () => {
    const f = await fixture();
    const control = await publishedArtifactControl(
      f,
      "control-exclusive-mkdir",
    );
    assert.ok(control.work.candidate);
    expect(
      completed(control.events, control.work.candidate.directory, "mkdir"),
    ).toBeGreaterThanOrEqual(0);
    const controlRows = artifactJobRows(f, control.attempt.identity.jobId);
    const attempt = await f.claim(
      submission(await sourceImage(), "fault-exclusive-mkdir"),
    );
    await f.complete(attempt, await nativePng(attempt));
    const sentinel = Buffer.from("pre-existing-candidate-sentinel", "utf8");
    const firstEvent = f.events.length;
    let reached:
      | {
          work: ArtifactWork;
          rows: ReturnType<typeof artifactJobRows>;
          names: string[];
          digest: string;
        }
      | undefined;
    const previous = f.hooks.before;
    f.hooks.before = async (event) => {
      await previous?.(event);
      if (
        reached ||
        event.stage !== "mkdir" ||
        event.role !== "candidate-directory"
      )
        return;
      const work = f.currentWork();
      assert.ok(work.candidate);
      assert.equal(event.path, work.candidate.directory);
      await localArtifactFiles.mkdir(event.path);
      const sentinelPath = join(event.path, "sentinel.txt");
      await writeActualFile(sentinelPath, sentinel);
      reached = {
        work,
        rows: artifactJobRows(f, attempt.identity.jobId),
        names: (await readdir(event.path)).sort(),
        digest: sha256(await readFile(sentinelPath)),
      };
      // Do not synthesize EEXIST: the next actual exclusive mkdir rejects.
    };
    await expect(f.settle(attempt)).resolves.toBe("blocked");
    assert.ok(reached, "the real candidate mkdir must be attempted");
    const { work } = reached;
    assert.ok(work.candidate);
    assertIntentAndReference(reached.rows, work);
    expect(reached.names).toEqual(["sentinel.txt"]);
    expect((await readdir(work.candidate.directory)).sort()).toEqual(
      reached.names,
    );
    const sentinelPath = join(work.candidate.directory, "sentinel.txt");
    expect(await readFile(sentinelPath)).toEqual(sentinel);
    expect(sha256(await readFile(sentinelPath))).toBe(reached.digest);
    const events = f.events.slice(firstEvent);
    expect(completed(events, work.candidate.directory, "mkdir")).toBe(-1);
    expect(
      events.filter(
        (item) => item.event.stage === "open" && item.event.flags === "wx",
      ),
    ).toEqual([]);
    expect(events.filter((item) => item.event.stage === "rename")).toEqual([]);
    for (const path of [
      work.candidate.pngPartPath,
      work.candidate.manifestPartPath,
      work.candidate.pngPath,
      work.candidate.manifestPath,
    ]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expectBlockedIntent(f, work, "mkdir");
    expect(artifactJobRows(f, control.attempt.identity.jobId)).toEqual(
      controlRows,
    );
    await assertCandidateFiles(control.work.candidate, control.png);
  });
});
