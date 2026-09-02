/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read/write helpers over the layer-contract tables. The parsed {@link LayerManifest} is the
 *   camelCase face of `layer_manifest`; validation happens at BOTH ends so a hand-built or
 *   corrupted layer fails loudly at open time rather than misbehaving downstream.
 */

import { CoverageBasis, LayerFreshnessPolicy, LayerTier, type LayerContractHandle } from "#layers/schema"
import { parseJSONStrict } from "#objects"

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
	 * The normalized-street column a extract is probed by, for layers keyed by STREET rather than by cell or id.
	 *
	 * Added because the contract's first three keys describe the two layer shapes that existed when it was written — a
	 * cellular one (`poi.db`, H3) and an id-joined one — and the situs extracts are a third. `address_point` and
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
 * says nothing about what it missed. Callers building negative evidence must condition on this rather than on
 * `completeness` alone, or an exclusion fires identically on a genuinely empty cell and on one we simply never
 * surveyed.
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
 * One `layer_coverage` row as a synchronous reader gets it back from `node:sqlite`.
 */
export interface CoverageRow {
	h3_cell: number
	completeness: number
	basis: string | null
	observed_rows: number
}

/**
 * A stored coverage row as the parsed {@link CoverageCell}, with the cell's own index and resolution beside it.
 *
 * SHARED BY EVERY POLYGON LAYER'S READER, and the reason is the second line of it. A NULL `basis` is an artifact built
 * before the column existed; it was recording source presence, so that is what it must read back as — never a stronger
 * basis than the builder actually had. Four readers writing that rule separately is four places for one of them to
 * write `?? CoverageBasis.Designated` and license an exclusion nobody measured.
 *
 * `undefined` in, `undefined` out: a cell with no coverage row is UNKNOWN, never `{completeness: 0}`.
 */
export function toCoverageCell(
	row: CoverageRow | undefined,
	h3CellIndex: string,
	resolution: number
): (CoverageCell & { h3CellIndex: string; resolution: number }) | undefined {
	if (!row) return undefined

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
 * The single `layer_manifest` row of `rows`, refused if there is not exactly one.
 *
 * A layer with no identity, or with two, must fail loudly rather than answer from whichever row came first.
 *
 * @param context Names the caller in the refusal.
 * @throws {Error} When the table does not hold exactly one row.
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
 * One `layer_manifest` row as a synchronous reader gets it back, mapped onto {@link LayerManifest}.
 *
 * SHARED BY EVERY LAYER READER, AND SEPARATE FROM THE IDENTITY CHECK ON PURPOSE. `readLayerManifest` above is the
 * Kysely path; a reader that opens the artifact with `node:sqlite` for its own synchronous probes reads the same single
 * row and needs the same mapping. What such readers do NOT share is how they recognize their own layer — most match a
 * fixed name, and a layer whose name carries a build's region suffix matches a prefix instead — so the mapping lives
 * here and the assertion stays with the caller. {@link parseManifestRows} is the fixed-name case, wired for the callers
 * that have one.
 *
 * @throws {Error} When the manifest's invariants do not hold.
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
 * The manifest of a layer whose name is FIXED, checked against `expectedName`.
 *
 * @param rows Every row of `layer_manifest`.
 * @param context Names the caller in every refusal.
 * @throws {Error} When the table does not hold exactly one row, when the layer is not `expectedName`, or when the
 *   manifest's invariants do not hold.
 */
export function parseManifestRows(
	rows: ReadonlyArray<Record<string, string | number | null>>,
	expectedName: string,
	context: string
): LayerManifest {
	const row = singleManifestRow(rows, context)

	if (String(row.name) !== expectedName) {
		throw new Error(
			`${context} is layer ${JSON.stringify(row.name)}, not ${JSON.stringify(expectedName)} — one publisher, one product, one vocabulary per artifact`
		)
	}

	return toLayerManifest(row)
}

/**
 * Refuse an artifact whose coverage would license a claim that the thing asked for is NOT there.
 *
 * A CONDITION RATHER THAN A CONVENTION, and shared because the rule is the contract's rather than any product's: a
 * layer whose source publishes no footprint may record presence and nothing else, and the day someone writes a stronger
 * basis without settling the footprint question the layer must refuse to open rather than answer confidently. Checked
 * over the DISTINCT bases, so the cost is one query however large the table.
 *
 * @param bases Every distinct `basis` in `layer_coverage`, NULL included.
 * @param reason The layer's own sentence saying why its coverage licenses no negative claim.
 * @throws {Error} When the table is empty, or when any basis supports an exclusion.
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
				`${context} carries a coverage row on basis ${JSON.stringify(basis)}, which supports an EXCLUSION. ` +
					`${reason} Until a mapped-footprint source is settled, every row must read ${CoverageBasis.SourcePresent}`
			)
		}
	}
}

/**
 * The build options every polygon-layer manifest reads the same way.
 */
export interface PolygonLayerBuildStamp {
	/**
	 * The product vintage — `layer_manifest.version` AND `source_vintage`.
	 */
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	/**
	 * ISO-8601, supplied by the caller. Never generated here: the contract says so, and a library-generated timestamp
	 * makes two builds of the same inputs differ.
	 */
	createdAt: string
	/**
	 * The resolution the cell index was built at — the h3 spine key's resolution.
	 */
	indexResolution: number
}

/**
 * The manifest every polygon layer stamps: the build's own options plus the product's identity, under the
 * `versioned-refresh` freshness policy and an h3 spine key.
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
		 * The table-qualified cell column a consumer joins on.
		 */
		cellColumn: string
		/**
		 * Defaults to {@link LayerTier.Shipped}; a product whose licence holds it at `build-local` passes its own.
		 */
		tier?: LayerTier
	}
): LayerManifest {
	return {
		name: product.name,
		version: options.sourceVintage,
		schemaVersion: product.schemaVersion,
		tier: product.tier ?? LayerTier.Shipped,
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
