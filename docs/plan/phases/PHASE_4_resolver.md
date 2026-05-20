# Phase 4 — Geocoder Fusion

**Goal:** add a resolver layer that takes parsed components and resolves to WOF place IDs + coordinates. The parser and geocoder share a representation, as the project creator originally intended.

**Status:** deferred until Phase 3 has shipped and gathered real-world feedback. Do not begin Phase 4 without explicit confirmation from the human.

**This document is a sketch, not a plan.** Phase 4 will get its own detailed plan when it begins.

## Why deferred

- Phase 3 must ship and prove the architecture in production before adding complexity.
- The right resolver design depends on what users do with the parser output. Premature optimization here is expensive to undo.
- Geocoding has its own data licensing complexity (commercial WOF use, OSM ODbL share-alike) that needs separate diligence.

## Sketch

Two viable resolver architectures:

### Option A: tantivy-backed (Airmail-style)

- Embed an Airmail-compatible index, built once from OSM + WOF
- Query via Rust→WASM binding or Rust sidecar
- Pro: planet-scale, fast, proven
- Con: introduces Rust into the runtime

### Option B: SQLite FTS5 + WOF SQLite

- Use WOF SQLite distributions directly
- FTS5 for full-text matching on place names
- Pro: pure Node, simple deployment
- Con: slower at planet scale, less sophisticated ranking

### Option C: External geocoder API

- Call out to a hosted geocoder (Pelias, Nominatim, BAN's `api-adresse.data.gouv.fr`)
- Pro: zero local index, always fresh
- Con: network dependency, rate limits, privacy implications

## Decisions deferred until Phase 4 begins

- Which resolver architecture
- Whether resolution feedback can correct parser output (the loop the project creator wanted)
- How to expose the joint type publicly
- Whether to ship as part of `@mailwoman/neural` or a new package

## What Phase 3 should leave in good shape for Phase 4

- The `ClassificationProposal` shape is rich enough to feed resolution
- `LocaleProfile` is the right place to declare resolver preferences
- The CLI's output format should be designed so adding a `resolution` field later is non-breaking

## Reading material to revisit when Phase 4 begins

- `ellenhp/airmail` source, especially the indexer
- `pelias/placeholder` (WOF-backed coarse resolver in Node)
- BAN's API for FR-specific resolution
- WOF's hierarchy walking utilities
