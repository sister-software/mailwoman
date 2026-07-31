# `@mailwoman/filer`

Identity-crosswalk infrastructure for FCC broadband filers: builds and reads `filer.db`, a graph linking a filer's identifiers — FRN, Form 499 filer ID, BDC `provider_id`, holding- and management-company name — across the FCC Form 499 filer database and the BDC provider list. Every relationship is provenanced (`source`, `source_vintage`) and temporally scoped (`valid_from`/`valid_to`); `filerLookup` reads the crosswalk `asOf` a date, reporting authoritative identifiers/clusters and inferred (name-matched) links separately, never conflated. Implements Phase 3a of the identity resolution pipeline.

## Specification

See [`docs/superpowers/specs/2026-07-31-filer-spine-design.md`](../docs/superpowers/specs/2026-07-31-filer-spine-design.md) for the full design reference.

## Architecture & Design Decisions

**Phase 3a Posture:** `filer.db` is deliberately **not** a layer-contract artifact in Phase 3a (decision 2). It has no coordinate references until ASR arrives in Phase 3c; since `layer_coverage` is H3-keyed, conforming to the layer contract would require writing coverage rows that assert nothing. Instead, it ships its own `filer_manifest` table — a single-row identity/provenance record (vintage, source, build SHA) — for its own bookkeeping. `filer_manifest` carries no coverage semantics of any kind; decision 2 exists specifically to keep this workspace out of the layer-contract's coverage-accounting obligations, not to reimplement them under a different name.
