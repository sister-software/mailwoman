/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read and write layer manifests and coverage records, validating them on both paths.
 */

import { supportsExclusion, CoverageBasis } from "@mailwoman/evidence"

import { parseJSONStrict, stringifyJSON } from "#json"
import { assertTierMatchesLicense } from "#layers/publication"
import { LayerFreshnessPolicy, LayerTier, type layerschemahandle } from "#layers/schema"
import { assertAdmissibleLicenseExpression } from "#license/obligations"

/**
 * Join keys available in a layer.
 * At least one key is required.
 */
export interface SpineKeys {
	h3?: { column: string; resolution: number }
	/**
	 * Column containing WOF IDs.
	 */
	wofID?: string
	/**
	 * Column containing address IDs.
	 */
	addressID?: string
	/**
	 * Normalized street column used to join address-point or street-segment layers.
	 */
	street?: { column: string }
}

/**
 * Parsed form of a layer manifest.
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
	/**
	 * How many records each input publisher supplied to this build, keyed by the publisher's own name.
	 *
	 * The count is of the input rather than the rows the artifact kept.
	 * It is recorded here because it cannot be recovered afterwards.
	 *
	 * Overture removes a release from its bucket once a newer one lands.
	 * A build that filtered its input leaves no way to count what the input held.
	 *
	 * Absent means the build did not record it.
	 * Every artifact built before this field has that state.
	 *
	 * A reader distinguishes that from a recorded zero and never reports the two the same way.
	 */
	sourceRecords?: Readonly<Record<string, number>>
}

export interface CoverageCell {
	h3Cell: number
	completeness: number
	/**
	 * Evidence basis for completeness.
	 * Defaults to `SourcePresent`.
	 */
	basis?: CoverageBasis
	observedRows: number
}

const BASES = new Set<string>(Object.values(CoverageBasis))

/**
 * Validate a coverage cell before storing or returning it.
 */
function assertCoverageCellInvariants(cell: CoverageCell): void {
	if (!Number.isFinite(cell.completeness) || cell.completeness < 0 || cell.completeness > 1) {
		throw new Error(`layer coverage: completeness must be a finite value in [0, 1], got ${cell.completeness}`)
	}

	if (cell.basis !== undefined && !BASES.has(cell.basis)) {
		throw new Error(`layer coverage: unknown basis ${stringifyJSON(cell.basis)}`)
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

function assertManifestInvariants(
	manifest: Pick<LayerManifest, "tier" | "freshnessPolicy" | "spineKeys" | "license">
): void {
	assertAdmissibleLicenseExpression(manifest.license, "layer manifest")

	if (!TIERS.has(manifest.tier)) {
		throw new Error(`layer manifest: unknown tier ${stringifyJSON(manifest.tier)}`)
	}

	if (!POLICIES.has(manifest.freshnessPolicy)) {
		throw new Error(`layer manifest: unknown freshness_policy ${stringifyJSON(manifest.freshnessPolicy)}`)
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
 * One `layer_coverage` row as a synchronous reader gets it back from `node:sqlite`.
 */
export interface CoverageRow {
	h3_cell: number
	completeness: number
	basis: string | null
	observed_rows: number
}

/**
 * Convert a stored row to a coverage cell.
 *
 * Legacy NULL bases map to `SourcePresent`; missing rows map to null.
 */
export function toCoverageCell(
	row: CoverageRow | null,
	h3CellIndex: string,
	resolution: number
): (CoverageCell & { h3CellIndex: string; resolution: number }) | null {
	if (!row) return null

	return {
		h3Cell: row.h3_cell,
		h3CellIndex,
		resolution,
		completeness: row.completeness,
		basis: (row.basis as CoverageBasis | null) ?? CoverageBasis.SourcePresent,
		observedRows: row.observed_rows,
	}
}

/**
 * Return the only manifest row, throwing unless exactly one exists.
 */
export function singleManifestRow(
	rows: ReadonlyArray<Record<string, string | number | null>>,
	context: string
): Record<string, string | number | null> {
	if (rows.length !== 1) {
		throw new Error(`${context} carries ${rows.length} manifest rows, expected 1`)
	}

	return rows[0]!
}

/**
 * Convert a stored row to a validated manifest.
 * Callers check the layer identity separately.
 */
export function toLayerManifest(row: Record<string, string | number | null>): LayerManifest {
	const manifest: LayerManifest = {
		name: String(row.name),
		version: String(row.version),
		schemaVersion: Number(row.schema_version),
		tier: String(row.tier) as LayerTier,
		license: String(row.license),
		...(row.attribution === null || row.attribution === undefined ? {} : { attribution: String(row.attribution) }),
		source: String(row.source),
		sourceVintage: String(row.source_vintage),
		buildCmd: String(row.build_cmd),
		buildSHA: String(row.build_sha),
		freshnessPolicy: String(row.freshness_policy) as LayerFreshnessPolicy,
		spineKeys: parseJSONStrict<SpineKeys>(String(row.spine_keys)),
		createdAt: String(row.created_at),
	}

	assertManifestInvariants(manifest)

	return manifest
}

/**
 * Parse one manifest row and verify its layer name.
 */
export function parseManifestRows(
	rows: ReadonlyArray<Record<string, string | number | null>>,
	expectedName: string,
	context: string
): LayerManifest {
	const row = singleManifestRow(rows, context)

	if (String(row.name) !== expectedName) {
		throw new Error(
			`${context} is layer ${stringifyJSON(row.name)}, not ${stringifyJSON(expectedName)} — one publisher, one product, one vocabulary per artifact`
		)
	}

	return toLayerManifest(row)
}

/**
 * Reject empty coverage tables and bases that permit exclusion claims.
 */
export function assertCoverageLicensesNoExclusion(
	bases: ReadonlyArray<string | null>,
	context: string,
	reason: string
): void {
	if (!bases.length) {
		throw new Error(
			`${context} holds no coverage rows — every location would read as unknown, which is indistinguishable from ground the publisher has not mapped`
		)
	}

	for (const value of bases) {
		const basis = (value as CoverageBasis | null) ?? CoverageBasis.SourcePresent

		if (supportsExclusion({ basis })) {
			throw new Error(
				`${context} carries a coverage row on basis ${stringifyJSON(basis)}, which supports an EXCLUSION. ` +
					`${reason} Until a mapped-footprint source is settled, every row must read ${CoverageBasis.SourcePresent}`
			)
		}
	}
}

/**
 * Shared build metadata for polygon-layer manifests.
 */
export interface PolygonLayerBuildStamp {
	/**
	 * Product vintage stored in `version` and `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * Caller-supplied ISO-8601 timestamp for reproducible builds.
	 */
	createdAt: string
	/**
	 * Resolution of the H3 index.
	 */
	indexResolution: number
}

/**
 * Create a versioned-refresh manifest for a polygon layer.
 *
 * @throws When the tier contradicts the license, as {@link assertTierMatchesLicense} decides.
 */
export function polygonLayerManifest(
	options: PolygonLayerBuildStamp,
	product: {
		name: string
		schemaVersion: number
		license: string
		attribution: string
		source: string
		/**
		 * H3 column used by consumers to join.
		 */
		cellColumn: string
		/**
		 * Defaults to `Shipped`.
		 */
		tier?: LayerTier
	}
): LayerManifest {
	const tier = product.tier ?? LayerTier.Shipped

	assertTierMatchesLicense({ tier, license: product.license }, `${product.name} manifest`)

	return {
		name: product.name,
		version: options.sourceVintage,
		schemaVersion: product.schemaVersion,
		tier,
		license: product.license,
		attribution: product.attribution,
		source: product.source,
		sourceVintage: options.sourceVintage,
		buildCmd: options.buildCmd,
		buildSHA: options.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.VersionedRefresh,
		spineKeys: {
			h3: { column: product.cellColumn, resolution: options.indexResolution },
		},
		createdAt: options.createdAt,
	}
}

/**
 * Insert one validated manifest row.
 */
export async function writeLayerManifest(db: layerschemahandle, manifest: LayerManifest): Promise<void> {
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
			spine_keys: stringifyJSON(manifest.spineKeys),
			created_at: manifest.createdAt,
			source_records: manifest.sourceRecords === undefined ? null : stringifyJSON(manifest.sourceRecords),
		})
		.execute()
}

/**
 * Read and validate the manifest.
 */
export async function readLayerManifest(db: layerschemahandle): Promise<LayerManifest> {
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
		// NULL and a missing column both mean the build recorded no count.
		// The key stays absent for either.
		// An empty object would make the build appear to have counted its publishers and found none.
		...(row.source_records === null || row.source_records === undefined
			? {}
			: { sourceRecords: parseJSONStrict<Record<string, number>>(row.source_records) }),
	}

	assertManifestInvariants(manifest)

	return manifest
}

/**
 * Rows per coverage insert, kept below SQLite's bound-variable limit.
 */
export const COVERAGE_INSERT_BATCH = 5000

/**
 * Insert coverage cells in batches below SQLite's parameter limit.
 */
export async function writeLayerCoverage(db: layerschemahandle, cells: CoverageCell[]): Promise<void> {
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
 * Read coverage for one H3 cell, or return `null` when no row exists.
 */
export async function readLayerCoverage(db: layerschemahandle, h3Cell: number): Promise<CoverageCell | null> {
	const row = await db.selectFrom("layer_coverage").selectAll().where("h3_cell", "=", h3Cell).executeTakeFirst()

	if (!row) return null

	const cell: CoverageCell = {
		h3Cell: row.h3_cell,
		completeness: row.completeness,
		// Legacy rows without a basis represent source presence.
		basis: (row.basis as CoverageBasis | null) ?? CoverageBasis.SourcePresent,
		observedRows: row.observed_rows,
	}

	assertCoverageCellInvariants(cell)

	return cell
}
