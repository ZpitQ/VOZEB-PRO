import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localArtifactFiles } from "../src/artifacts.js";
import { localInputFiles } from "../src/jobs.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("real directory durability", () => {
  it("syncs a real directory for durable input files", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "enhancement-input-directory-sync-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "child.bin");
    const bytes = Buffer.from("durable input child");
    await writeFile(path, bytes);

    await expect(
      localInputFiles.syncDirectory(directory),
    ).resolves.toBeUndefined();

    expect(await readFile(path)).toEqual(bytes);
  });

  it("syncs a real directory for durable artifact files", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "enhancement-artifact-directory-sync-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "child.bin");
    const bytes = Buffer.from("durable artifact child");
    await writeFile(path, bytes);

    await expect(
      localArtifactFiles.syncDirectory(directory, () => true),
    ).resolves.toBeUndefined();

    expect(await readFile(path)).toEqual(bytes);
  });
});
