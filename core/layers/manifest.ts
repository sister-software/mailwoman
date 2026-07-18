/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read/write helpers over the layer-contract tables. The parsed {@link LayerManifest} is the
 *   camelCase face of `layer_manifest`; validation happens at BOTH ends so a hand-built or
 *   corrupted layer fails loudly at open time rather than misbehaving downstream.
 */

import type { Kysely } from "kysely"

import { LayerFreshnessPolicy, LayerTier, type LayerContractDatabase } from "./schema.ts"

/** Which spine columns a layer carries. At least one key is required. */
export interface SpineKeys {
	h3?: { column: string; resolution: number }
	/** Column name holding WOF ids, when present. */
	wofID?: string
	/** Column name holding `@mailwoman/address-id` keys, when present. */
	addressID?: string
}

/** Parsed manifest — see {@link LayerManifestTable} for the storage form. */
export interface LayerManifest {
	name: string
	version: string
	schemaVersion: number
	tier: LayerTier
	license: string
	attribution?: string
	source: string
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	freshnessPolicy: LayerFreshnessPolicy
	spineKeys: SpineKeys
	createdAt: string
}

export interface CoverageCell {
	h3Cell: number
	completeness: number
	observedRows: number
}

const TIERS = new Set<string>(Object.values(LayerTier))
const POLICIES = new Set<string>(Object.values(LayerFreshnessPolicy))

function assertManifestInvariants(manifest: Pick<LayerManifest, "tier" | "freshnessPolicy" | "spineKeys">): void {
	if (!TIERS.has(manifest.tier)) {
		throw new Error(`layer manifest: unknown tier ${JSON.stringify(manifest.tier)}`)
	}
	if (!POLICIES.has(manifest.freshnessPolicy)) {
		throw new Error(`layer manifest: unknown freshness_policy ${JSON.stringify(manifest.freshnessPolicy)}`)
	}
	if (!manifest.spineKeys.h3 && !manifest.spineKeys.wofID && !manifest.spineKeys.addressID) {
		throw new Error("layer manifest: at least one spine key (h3, wofID, addressID) is required")
	}
}

/** Insert the single manifest row. Call exactly once, from the layer's build script. */
export async function writeLayerManifest(db: Kysely<LayerContractDatabase>, manifest: LayerManifest): Promise<void> {
	assertManifestInvariants(manifest)

	await db
		.insertInto("layer_manifest")
		.values({
			name: manifest.name,
			version: manifest.version,
			schema_version: manifest.schemaVersion,
			tier: manifest.tier,
			license: manifest.license,
			attribution: manifest.attribution ?? null,
			source: manifest.source,
			source_vintage: manifest.sourceVintage,
			build_cmd: manifest.buildCmd,
			build_sha: manifest.buildSHA,
			freshness_policy: manifest.freshnessPolicy,
			spine_keys: JSON.stringify(manifest.spineKeys),
			created_at: manifest.createdAt,
		})
		.execute()
}

/** Read + validate the manifest. Throws if the table is empty, multi-row, or invalid. */
export async function readLayerManifest(db: Kysely<LayerContractDatabase>): Promise<LayerManifest> {
	const rows = await db.selectFrom("layer_manifest").selectAll().execute()

	if (rows.length !== 1) {
		throw new Error(`layer manifest: expected exactly 1 row, found ${rows.length}`)
	}
	const row = rows[0]!
	const manifest: LayerManifest = {
		name: row.name,
		version: row.version,
		schemaVersion: row.schema_version,
		tier: row.tier as LayerTier,
		license: row.license,
		...(row.attribution === null ? {} : { attribution: row.attribution }),
		source: row.source,
		sourceVintage: row.source_vintage,
		buildCmd: row.build_cmd,
		buildSHA: row.build_sha,
		freshnessPolicy: row.freshness_policy as LayerFreshnessPolicy,
		spineKeys: JSON.parse(row.spine_keys) as SpineKeys,
		createdAt: row.created_at,
	}

	assertManifestInvariants(manifest)

	return manifest
}

/** Bulk-insert coverage cells (build-time; cold path, so Kysely inserts are fine). */
export async function writeLayerCoverage(db: Kysely<LayerContractDatabase>, cells: CoverageCell[]): Promise<void> {
	if (cells.length === 0) return

	await db
		.insertInto("layer_coverage")
		.values(cells.map((c) => ({ h3_cell: c.h3Cell, completeness: c.completeness, observed_rows: c.observedRows })))
		.execute()
}

/**
 * Look up coverage for one short H3 cell. `undefined` = the cell was never surveyed (UNKNOWN) — callers must not
 * conflate this with `{completeness: 0}`.
 */
export async function readLayerCoverage(
	db: Kysely<LayerContractDatabase>,
	h3Cell: number
): Promise<CoverageCell | undefined> {
	const row = await db.selectFrom("layer_coverage").selectAll().where("h3_cell", "=", h3Cell).executeTakeFirst()

	if (!row) return undefined

	return { h3Cell: row.h3_cell, completeness: row.completeness, observedRows: row.observed_rows }
}
