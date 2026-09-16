# Canvas Mask Semantic Edit Design

## Goal

Make Canvas masked edits through the `sub2api` JSON protocol follow the user's requested content and place it inside the painted region while preserving every pixel outside that region.

## Root Cause

The Canvas currently sends the source image in `image_urls` and sends the mask only through the top-level `mask` field. The configured upstream does not consume that field as visual input. The shared sub2api prompt also describes every reference as a person or character identity reference, so scene edits are biased toward recreating an unrelated subject instead of editing the selected area.

The client already composites the generated result over the source with the mask. This protects unselected pixels, but it cannot make the upstream generate the requested object at the correct location.

## Design

The mask dialog calculates normalized bounds and center coordinates from painted alpha pixels. The edit region travels with the mask through the Canvas node snapshot, task request, and stored image task so retries use the same selection.

For masked `sub2api` edits, the JSON request keeps source and ordinary reference images first and appends the mask URL as the final `image_urls` entry. The prompt identifies that final image as a binary mask, explains that transparent pixels are editable and opaque pixels must remain unchanged, and includes the normalized bounds and center. It requires the complete requested object to fit inside that region and prohibits unrelated people, animals, furniture, objects, or scene replacement.

Unmasked sub2api edits retain the existing reference-image behavior. Other providers keep their current mask protocols.

The existing local pixel compositor remains the final boundary that guarantees pixels outside the mask are copied from the source.

## Data Contract

The mask reference gains optional `editRegion` metadata:

- `left`, `top`, `right`, and `bottom`: normalized selected bounds in the source image.
- `centerX` and `centerY`: normalized center of those bounds.

All values are finite and clamped to `[0, 1]` before entering the provider prompt.

## Validation

- A fixture test verifies the mask is the final sub2api `image_urls` item and the prompt contains the mask semantics and normalized location.
- A fixture test verifies masked prompts do not contain person or character identity language.
- Existing unmasked fixture coverage verifies its request remains unchanged.
- Type checking, linting, formatting, unit tests, release checks, build, and required desktop Chromium gates validate the full change.
