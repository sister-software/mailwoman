/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read/write helpers over the layer-contract tables. The parsed {@link LayerManifest} is the
 *   camelCase face of `layer_manifest`; validation happens at BOTH ends so a hand-built or
 *   corrupted layer fails loudly at open time rather than misbehaving downstream.
 */

import { parseJSONStrict } from "../objects.ts"
import { CoverageBasis, LayerFreshnessPolicy, LayerTier, type LayerContractHandle } from "./schema.ts"

/**
 * Which spine columns a layer carries. At least one key is required.
 */
export interface SpineKeys {
	h3?: { column: string; resolution: number }
	/**
	 * Column name holding WOF ids, when present.
	 */
	wofID?: string
	/**
	 * Column name holding `@mailwoman/address-id` keys, when present.
	 */
	addressID?: string
	/**
	 * The normalized-street column a shard is probed by, for layers keyed by STREET rather than by cell or id.
	 *
	 * Added because the contract's first three keys describe the two layer shapes that existed when it was written — a
	 * cellular one (`poi.db`, H3) and an id-joined one — and the situs shards are a third. `address_point` and
	 * `street_segment` carry no H3 cell, no WOF id and no address-id; they are probed on `(postcode | locality,
	 * street_norm, number)`. Declaring one of the other three for them would name a column that does not exist, in the
	 * field a consumer uses to join.
	 */
	street?: { column: string }
}

/**
 * Parsed manifest — see {@link LayerManifestTable} for the storage form.
 */
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
	/**
	 * What `completeness` rests on. A writer that omits it is declaring {@link CoverageBasis.SourcePresent} — the weakest
	 * reading — because a builder that has not thought about basis is recording source presence whether or not it says
	 * so.
	 */
	basis?: CoverageBasis
	observedRows: number
}

/**
 * Whether a coverage reading can support an EXCLUSION — a claim that the thing asked for is not there.
 *
 * Presence is supportable from any basis. Absence is not: `source_present` records that the source returned rows, which
 * says nothing about what it missed. Callers building negative evidence must gate on this rather than on `completeness`
 * alone, or an exclusion fires identically on a genuinely empty cell and on one we simply never surveyed.
 */
export function supportsExclusion(cell: Pick<CoverageCell, "basis">): boolean {
	return cell.basis === CoverageBasis.Designated || cell.basis === CoverageBasis.Surveyed
}

const BASES = new Set<string>(Object.values(CoverageBasis))

/**
 * Reject a malformed coverage cell at BOTH ends, the way {@link assertManifestInvariants} does for the manifest.
 *
 * The magnitudes here are read as epistemics, so a well-formed wrong one is worse than a throw: a `completeness` above
 * 1 or an unknown `basis` reaching {@link supportsExclusion} turns into confident negative evidence, and a negative
 * `observedRows` reads as a survey that found less than nothing. None of that is distinguishable downstream from a real
 * measurement.
 */
function assertCoverageCellInvariants(cell: CoverageCell): void {
	if (!Number.isFinite(cell.completeness) || cell.completeness < 0 || cell.completeness > 1) {
		throw new Error(`layer coverage: completeness must be a finite value in [0, 1], got ${cell.completeness}`)
	}

	if (cell.basis !== undefined && !BASES.has(cell.basis)) {
		throw new Error(`layer coverage: unknown basis ${JSON.stringify(cell.basis)}`)
	}

	if (!Number.isSafeInteger(cell.observedRows) || cell.observedRows < 0) {
		throw new Error(`layer coverage: observedRows must be a non-negative integer, got ${cell.observedRows}`)
	}

	if (!Number.isSafeInteger(cell.h3Cell) || cell.h3Cell < 0) {
		throw new Error(`layer coverage: h3Cell must be a non-negative 48-bit short cell, got ${cell.h3Cell}`)
	}
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

	if (
		!manifest.spineKeys.h3 &&
		!manifest.spineKeys.wofID &&
		!manifest.spineKeys.addressID &&
		!manifest.spineKeys.street
	) {
		throw new Error("layer manifest: at least one spine key (h3, wofID, addressID, street) is required")
	}
}

/**
 * Insert the single manifest row. Call exactly once, from the layer's build script.
 */
export async function writeLayerManifest(db: LayerContractHandle, manifest: LayerManifest): Promise<void> {
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

/**
 * Read + validate the manifest. Throws if the table is empty, multi-row, or invalid.
 */
export async function readLayerManifest(db: LayerContractHandle): Promise<LayerManifest> {
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
		spineKeys: parseJSONStrict<SpineKeys>(row.spine_keys),
		createdAt: row.created_at,
	}

	assertManifestInvariants(manifest)

	return manifest
}

/**
 * Rows per INSERT statement (4 bound params/row = 16,000 params/statement), kept safely under SQLite's default 32,766
 * bound-variable ceiling — a continental-scale build's res-6 coverage cell count blows past that limit in a single
 * `.values()` call (found 2026-07-19).
 */
export const COVERAGE_INSERT_BATCH = 5000

/**
 * Bulk-insert coverage cells (build-time; cold path, so Kysely inserts are fine), chunked to stay under SQLite's
 * bound-variable limit.
 */
export async function writeLayerCoverage(db: LayerContractHandle, cells: CoverageCell[]): Promise<void> {
	if (!cells.length) return

	for (const cell of cells) {
		assertCoverageCellInvariants(cell)
	}

	for (let i = 0; i < cells.length; i += COVERAGE_INSERT_BATCH) {
		const batch = cells.slice(i, i + COVERAGE_INSERT_BATCH)

		await db
			.insertInto("layer_coverage")
			.values(
				batch.map((c) => ({
					h3_cell: c.h3Cell,
					completeness: c.completeness,
					basis: c.basis ?? CoverageBasis.SourcePresent,
					observed_rows: c.observedRows,
				}))
			)
			.execute()
	}
}

/**
 * Look up coverage for one short H3 cell. `undefined` = the cell was never surveyed (UNKNOWN) — callers must not
 * conflate this with `{completeness: 0}`.
 */
export async function readLayerCoverage(db: LayerContractHandle, h3Cell: number): Promise<CoverageCell | undefined> {
	const row = await db.selectFrom("layer_coverage").selectAll().where("h3_cell", "=", h3Cell).executeTakeFirst()

	if (!row) return undefined

	const cell: CoverageCell = {
		h3Cell: row.h3_cell,
		completeness: row.completeness,
		// A NULL basis is an artifact built before the column existed. It was recording source presence,
		// so that is what it reads back as — never a stronger basis than the builder actually had.
		basis: (row.basis as CoverageBasis | null) ?? CoverageBasis.SourcePresent,
		observedRows: row.observed_rows,
	}

	assertCoverageCellInvariants(cell)

	return cell
}
