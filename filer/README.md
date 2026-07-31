# `@mailwoman/filer`

Identity crosswalk infrastructure for Mailwoman: coordinates address records to canonical geocoded entities across geographies and address systems. Implements Phase 3a of the identity resolution pipeline.

## Specification

See [`docs/articles/plan/`](../docs/articles/plan/) for the full design reference and phase roadmap.

## Architecture & Design Decisions

**Phase 3a Posture:** `filer.db` is deliberately **not** a layer-contract artifact in Phase 3a. It has no coordinate references until ASR arrives in Phase 3c; since `layer_coverage` is H3-keyed, conforming to the layer contract would require writing coverage rows that assert nothing. Instead, it ships its own `filer_manifest` table for coordination and coverage accounting.
