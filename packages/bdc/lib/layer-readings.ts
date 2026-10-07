/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dossier layer readings from a BDC database, one per technology for a building's census block.
 *   Each reading's subject is the building, and its survey date is the database's vintage.
 *   A block is surveyed when its res-6 cell has a coverage row, and its reading then counts the
 *   technology's filing summaries. A block that cannot be placed, or whose cell has no coverage row,
 *   is unknown.
 */

import type { EntityID, LayerReading, SourceRecordID } from "@mailwoman/dossier"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { filingLandscape } from "#filing/landscape"
import type { BDCDatabase } from "#schema"

const LAYER_BY_TECHNOLOGY: ReadonlyMap<number, string> = new Map([
	[40, "fcc-bdc-cable"],
	[50, "fcc-bdc-fttp"],
])

/**
 * The dossier layer name for a BDC technology code: `fcc-bdc-cable` for cable (40)
 * and `fcc-bdc-fttp` for fiber to the premises (50).
 *
 * A code without a layer name throws rather than receive a name invented for it.
 */
export function bdcTechnologyLayer(technologyCode: number): string {
	const layer = LAYER_BY_TECHNOLOGY.get(technologyCode)

	if (!layer) {
		throw new Error(`bdcTechnologyLayer: technology code ${technologyCode} has no dossier layer name`)
	}

	return layer
}

/**
 * The building, block and technologies {@link bdcLayerReadings} reads.
 */
export interface BDCLayerReadingQuery {
	/**
	 * The building the readings belong to.
	 */
	subject: EntityID
	/**
	 * The building's census block, as its 15-digit GEOID.
	 */
	geoid: string
	/**
	 * The technology codes to read, one reading each.
	 *
	 * A passed code attests that the database's build loaded that technology's rows.
	 * A zero for a technology the build never loaded would describe the build rather than the block.
	 */
	technologyCodes: readonly number[]
	/**
	 * The source record for the BDC files the database was built from.
	 */
	source: SourceRecordID
	/**
	 * Places a block that has no rows of its own, as `geoidCellResolver` builds one.
	 * Without it, such a block is unknown.
	 */
	resolveGeoidCell?: (geoid: string) => number | null
}

/**
 * Read a building's census block as one dossier layer reading per technology.
 *
 * Every reading's `surveyedAt` is the database's source vintage.
 * For a surveyed block, `basis` is the basis its coverage row stores, and `records` counts
 * the technology's filing summaries at the block: one per provider and speed bucket.
 *
 * For an unknown block, `basis` and `records` are `null`.
 * A failed database read throws.
 */
export async function bdcLayerReadings(
	db: DatabaseClient<BDCDatabase>,
	query: BDCLayerReadingQuery
): Promise<LayerReading[]> {
	if (!/^\d{15}$/.test(query.geoid)) {
		throw new Error(`bdcLayerReadings: a census block GEOID has 15 digits, got ${query.geoid}`)
	}

	if (!query.technologyCodes.length) {
		throw new Error("bdcLayerReadings: `technologyCodes` must name at least one technology")
	}

	const layers = query.technologyCodes.map((technologyCode) => ({
		technologyCode,
		layer: bdcTechnologyLayer(technologyCode),
	}))

	const landscape = await filingLandscape(db, { geoids: [query.geoid], resolveGeoidCell: query.resolveGeoidCell })
	const surveyed = landscape.surveyed_block_count > 0

	return layers.map(({ technologyCode, layer }) => ({
		layer,
		extent: `census-block:${query.geoid}`,
		subject: query.subject,
		basis: surveyed ? landscape.coverage_basis : null,
		surveyedAt: landscape.vintage,
		records: surveyed ? landscape.filings.filter((filing) => filing.technology_code === technologyCode).length : null,
		evidence: { source: query.source, observedAt: null, validFrom: null, validTo: null },
	}))
}
