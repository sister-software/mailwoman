/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/geographic-model` — the world-semantic layer: stable concepts beyond the POI
 *   vocabulary, relation definitions, activities and affordances, rule modality, source
 *   observations, derived facts, derivation provenance, deterministic compilation and validation,
 *   and mappings from external vocabularies into world concepts.
 *
 *   The public surface is the authored-record schema (`./schema.ts`), its deterministic validator
 *   (`./validate.ts`), the compiler that turns a validated document into the runtime artifact
 *   (`./compile.ts`), the artifact's shape and canonical bytes (`./artifact.ts`), and the lookups a
 *   runtime consumer reads it through (`./lookup.ts`). All five are re-exported here and all five are
 *   reachable as curated subpaths.
 *
 *   The authoring loader (`./load.ts`, the `./load` subpath) is deliberately NOT re-exported here. It
 *   is the only module in the package that touches a filesystem, and it belongs to the build step that
 *   produces an artifact rather than to the consumers that read one. The first authored document
 *   arrives with #1927; this entry point carries no data.
 *
 *   Four things this package must never hold, each owned elsewhere and each a rule the review
 *   applies rather than a preference:
 *
 *   1. **Ranking policy.** No weights, boosts, penalties, or candidate-ordering API — not as a
 *      function, not as a type. Candidate ordering belongs to `@mailwoman/resolver`, and the decode
 *      objective to `@mailwoman/neural` plus `@mailwoman/core/decoder`. Knowledge here creates
 *      observations; it never overrides learned interpretation.
 *   2. **A second POI vocabulary.** External and curated POI categories, their containment
 *      hierarchy, the Overture-leaf translation, the query-phrase lexicon and the brand table all
 *      belong to `@mailwoman/poi-taxonomy`. This package maps INTO those identifiers.
 *   3. **A second coverage register.** Dataset identity and coverage epistemics belong to
 *      `@mailwoman/core/layers`. An expected-but-absent observation becomes negative evidence only
 *      where `supportsExclusion` permits it there.
 *   4. **Empirical affordance statistics.** #1683 fits those. This package owns the stable
 *      activity and affordance identifiers they are fitted against, and nothing numeric about them.
 *
 *   `@mailwoman/core` must not depend on this package. Core ships the pipeline contract and roughly
 *   9 MB of reference data to every consumer, so a world-semantics dependency there is one every
 *   drop-in API inherits without asking for it. Reversing that direction is an explicit amendment to
 *   the boundary record, not a convenience during implementation.
 *
 *   Boundary record: `docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md` (#1917).
 *   Program parent: #1916.
 */

export * from "#artifact"
export * from "#compile"
export * from "#lookup"
export * from "#schema"
export * from "#validate"
