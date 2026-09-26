/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `@mailwoman/geographic-model` — the world-semantic layer: stable concepts beyond the POI
 * vocabulary, relation definitions, activities and affordances, rule modality, source observations,
 * derived facts, derivation provenance, and deterministic compilation and validation.
 *
 * The authoring loader (`./load.ts`, the `./load` subpath) is deliberately not re-exported here: it is
 * the only module in the package that touches a filesystem and belongs to the build step rather than
 * to the consumers that read an artifact.
 *
 * Four things this package must never hold, each owned elsewhere:
 *
 * 1. Ranking policy — no weights, boosts, penalties, or candidate-ordering API; candidate ordering
 *    belongs to `@mailwoman/resolver`, and the decode objective to `@mailwoman/neural` plus
 *    `@mailwoman/core/decoder`. Knowledge here creates observations and never overrides learned
 *    interpretation.
 * 2. A second POI vocabulary — external and curated POI categories, their containment hierarchy, the
 *    Overture-leaf translation, the query-phrase lexicon and the brand table belong to
 *    `@mailwoman/poi-taxonomy`; this package maps into those identifiers.
 * 3. A second coverage register — dataset identity and coverage epistemics belong to
 *    `@mailwoman/core/layers`, and an expected-but-absent observation becomes negative evidence only
 *    where `supportsExclusion` permits it there.
 * 4. Empirical affordance statistics — this package owns the stable activity and affordance
 *    identifiers those statistics are fitted against, and no numeric values about them.
 *
 * `@mailwoman/core` must not depend on this package: core ships the pipeline interface and roughly
 * 9 MB of reference data to every consumer, so a world-semantics dependency there is one every
 * drop-in API inherits without asking.
 */

export * from "#artifact"
export * from "#compile"
export * from "#lookup"
export * from "#schema"
export * from "#validate"
