/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Typed schema for the spatial-layer contract — the two tables EVERY layer database embeds,
 *   regardless of tier: `layer_manifest` (single-row identity/provenance/licensing record) and
 *   `layer_coverage` (per-H3-cell survey completeness). The contract is what lets shipped,
 *   build-local, and private layers share one query surface. Spec:
 *   docs/superpowers/specs/2026-07-18-spatial-layers-and-poi-design.md §2.1.
 *
 *   Coverage carries the meaning-of-zero rule: a MISSING coverage row means "unmapped/unknown",
 *   never "surveyed and empty". Consumers must treat absence as absence of evidence.
 */

import { sql, type Kysely } from "kysely"

/**
 * Distribution tier of a layer. Shipped = permissive-license, published by us.
 */
export const LayerTier = {
	Shipped: "shipped",
	/**
	 * Share-alike sources (ODbL): we ship the builder CLI, the user builds locally.
	 */
	BuildLocal: "build-local",
	/**
	 * The user's own data, conforming to the contract, never distributed.
	 */
	Private: "private",
} as const

export type LayerTier = (typeof LayerTier)[keyof typeof LayerTier]

/**
 * How a layer is kept current.
 */
export const LayerFreshnessPolicy = {
	/**
	 * Immutable artifact; updates are full rebuilds (the gazetteer discipline).
	 */
	Sealed: "sealed",
	/**
	 * Periodically re-issued under the same name (e.g. registries of people/programs).
	 */
	VersionedRefresh: "versioned-refresh",
} as const

export type LayerFreshnessPolicy = (typeof LayerFreshnessPolicy)[keyof typeof LayerFreshnessPolicy]

/**
 * The single-row layer identity record. See {@link LayerManifest} for the parsed form.
 */
export interface LayerManifestTable {
	name: string
	version: string
	schema_version: number
	/**
	 * One of {@link LayerTier}.
	 */
	tier: string
	/**
	 * SPDX-ish license expression, e.g. `CDLA-Permissive-2.0`, `ODbL-1.0`.
	 */
	license: string
	attribution: string | null
	source: string
	source_vintage: string
	build_cmd: string
	build_sha: string
	/**
	 * One of {@link LayerFreshnessPolicy}.
	 */
	freshness_policy: string
	/**
	 * JSON-encoded spine-key declaration (see `SpineKeys` in `manifest.ts`).
	 */
	spine_keys: string
	/**
	 * ISO-8601, supplied by the build script (never generated in-library).
	 */
	created_at: string
}

/**
 * Per-cell survey completeness. Missing row = unknown, NOT zero.
 */
/**
 * What a `completeness` value RESTS ON. The magnitude alone cannot be acted on: a cell recorded at `1.0` because an
 * authority designates the set complete, and a cell recorded at `1.0` because the source happened to return rows there,
 * license entirely different conclusions.
 *
 * Only {@link CoverageBasis.Designated} and {@link CoverageBasis.Surveyed} can support an EXCLUSION — "the thing you
 * asked for is not here". {@link CoverageBasis.SourcePresent} supports presence and nothing else: the source looked,
 * which is not the same as the source found everything.
 */
export const CoverageBasis = {
	/**
	 * An authority declares the set complete for this cell — BAN holding every address in a commune. A miss inside a
	 * designated cell IS evidence of absence.
	 */
	Designated: "designated",
	/**
	 * We measured completeness ourselves against an independent reference, and `completeness` carries that measurement. A
	 * miss is evidence of absence in proportion to the value.
	 */
	Surveyed: "surveyed",
	/**
	 * The source returned rows in this cell and we recorded that. Says nothing about what the source missed. A miss here
	 * is UNKNOWN, never absence.
	 */
	SourcePresent: "source_present",
} as const

export type CoverageBasis = (typeof CoverageBasis)[keyof typeof CoverageBasis]

export interface LayerCoverageTable {
	/**
	 * 48-bit short H3 cell at the resolution declared by the manifest's spine keys.
	 */
	h3_cell: number
	/**
	 * Estimated completeness of the source survey in this cell, 0..1.
	 *
	 * Never read this without reading {@link LayerCoverageTable.basis} — see {@link CoverageBasis}.
	 */
	completeness: number
	/**
	 * What the `completeness` value rests on. One of {@link CoverageBasis}.
	 *
	 * NULL means the row predates this column, and must be read as {@link CoverageBasis.SourcePresent} — the weakest
	 * reading, because that is what every layer built before the column was writing.
	 */
	basis: CoverageBasis | null
	/**
	 * Rows this layer actually holds in the cell.
	 */
	observed_rows: number
}

/**
 * Pass to `new DatabaseClient<LayerContractDatabase>(...)` (or intersect into a layer's own schema).
 */
export interface LayerContractDatabase {
	layer_manifest: LayerManifestTable
	layer_coverage: LayerCoverageTable
}

/**
 * Create `layer_manifest`. Single row enforced by `name` PK + the writer's insert-once discipline.
 */
export async function createLayerManifestTable(db: Kysely<LayerContractDatabase>): Promise<void> {
	await db.schema
		.createTable("layer_manifest")
		.addColumn("name", "text", (c) => c.primaryKey())
		.addColumn("version", "text", (c) => c.notNull())
		.addColumn("schema_version", "integer", (c) => c.notNull())
		.addColumn("tier", "text", (c) => c.notNull())
		.addColumn("license", "text", (c) => c.notNull())
		.addColumn("attribution", "text")
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("source_vintage", "text", (c) => c.notNull())
		.addColumn("build_cmd", "text", (c) => c.notNull())
		.addColumn("build_sha", "text", (c) => c.notNull())
		.addColumn("freshness_policy", "text", (c) => c.notNull())
		.addColumn("spine_keys", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute()
}

/**
 * Create `layer_coverage` — small fixed-width rows probed by PK, the WITHOUT ROWID sweet spot.
 */
export async function createLayerCoverageTable(db: Kysely<LayerContractDatabase>): Promise<void> {
	await db.schema
		.createTable("layer_coverage")
		.addColumn("h3_cell", "integer", (c) => c.primaryKey())
		.addColumn("completeness", "real", (c) => c.notNull())
		// Nullable on purpose: artifacts built before this column exist and read back as NULL, which
		// `readLayerCoverage` resolves to `source_present` — what they were in fact recording.
		.addColumn("basis", "text")
		.addColumn("observed_rows", "integer", (c) => c.notNull())
		// `WITHOUT ROWID` has no first-class builder; the raw modifier is the idiomatic fallback.
		.modifyEnd(sql`without rowid`)
		.execute()
}
