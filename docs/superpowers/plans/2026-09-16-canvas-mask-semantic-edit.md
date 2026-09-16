# Canvas Mask Semantic Edit Implementation Plan

**Goal:** Make sub2api Canvas mask edits follow the requested content within the selected region without changing unselected pixels.

**Architecture:** Compute normalized selection geometry in the mask dialog, persist it with the mask reference and Canvas task snapshot, and specialize the sub2api masked-edit request so the upstream receives the mask as visual input plus explicit spatial instructions. Keep local compositing as the final pixel boundary.

**Tech Stack:** Next.js, React, TypeScript, Vitest, Playwright, Docker, GitHub Actions.

## Constraints

- Preserve existing behavior for unmasked sub2api edits and all other providers.
- Keep source/reference images before the mask in `image_urls`.
- Preserve normalized region metadata across task recovery and Canvas retries.
- Publish production only from the merged `main` commit tagged `v0.0.21`.
- Keep deployment Compose defaults on `ghcr.io/zpitq/vozeb-pro:latest`.

### Task 1: Lock the request contract with failing tests

**Files:**

- Modify: `web/src/app/api/image-tasks/image-task-openai-live.test.ts`

- [x] Add a masked sub2api fixture case with source, mask, and normalized edit region.
- [x] Assert the mask URL is the final `image_urls` item.
- [x] Assert the prompt explains mask alpha semantics, bounds, center, containment, and scene preservation.
- [x] Assert masked prompts exclude person and character identity wording.
- [x] Confirm the new test fails before implementation.

### Task 2: Carry selection geometry through Canvas and image tasks

**Files:**

- Modify: `web/src/types/image.ts`
- Modify: `web/src/lib/server/image-task-store.ts`
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/app/(user)/canvas/types.ts`
- Modify: `web/src/app/(user)/canvas/components/canvas-node-mask-edit-dialog.tsx`
- Modify: `web/src/app/(user)/canvas/[id]/canvas-page-utils.ts`
- Modify: `web/src/app/(user)/canvas/[id]/use-canvas-node-media-actions.tsx`

- [x] Calculate normalized bounds and center from painted selection pixels.
- [x] Attach the region to the uploaded mask and persisted Canvas metadata.
- [x] Preserve the region through request serialization, task storage, recovery, and retry.

### Task 3: Build the masked sub2api request

**Files:**

- Modify: `web/src/app/api/image-tasks/image-task-openai.ts`

- [x] Append the mask URL after ordinary source/reference URLs only for sub2api masked edits.
- [x] Generate mask-specific spatial instructions from validated normalized geometry.
