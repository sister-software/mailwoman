/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the `filing_landscape` summary from a BDC database.
 *
 *   A queried block counts as surveyed only when its res-6 parent cell appears in `layer_coverage`;
 *   anything else is unknown. A surveyed block with zero filings is a different result. A GEOID
 *   query takes each block's res-9 cell from its `bdc_availability` rows. A GEOID with no rows of
 *   its own takes its cell from the caller's `resolveGeoidCell`, and without one the block is unknown.
 *   An `h3Cells` query supplies the cell, so a covered cell with no rows reports as surveyed with
 *   zero filings.
 *
 *   The res-6 parent comes from the res-9 cell rather than from the block centroid. H3 cells do not
 *   nest exactly, and the two derivations disagree for some points. `blockCentroidCells` derives both
 *   cells for the builder and for `geoidCellResolver`. A resolver built over the centroid source the
 *   build used therefore places a zero-row block in the cell the builder would have stored for it.
 *
 *   Coverage is recorded per res-6 cell and counts the loaded rows of every technology. A zero-row
 *   block reads as surveyed when another block in its res-6 cell has a row in the build. A zero for
 *   one technology holds only for a technology whose rows the build loaded.
 */

import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { CoverageBasis } from "@mailwoman/evidence"
import { shortCellToInt, shortCellToParentInt, type H3Cell } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"
import { sql } from "kysely"

import { BDC_COVERAGE_H3_RESOLUTION, BDC_H3_RESOLUTION, type BDCDatabase } from "#schema"

/**
 * Query for {@link filingLandscape}; set exactly one of `geoids` or `h3Cells`.
 */
export interface FilingLandscapeQuery {
	geoids?: string[]
	h3Cells?: number[]
	/**
	 * Resolves a GEOID to its res-9 short cell when the block has no `bdc_availability` rows
	 * of its own. {@link geoidCellResolver} builds one from a block-centroid lookup.
	 *
	 * Consulted only in `geoids` mode.
	 * Without it, a GEOID with zero rows reports as unknown rather than surveyed-empty.
	 */
	resolveGeoidCell?: (geoid: string) => number | null
}

/**
 * One provider/technology/speed-bucket group's block count within the query.
 *
 * `block_count` counts distinct blocks: a block can hold several rows for one provider
 * and technology at different speeds, so counting rows would count it twice.
 */
export interface ProviderFilingSummary {
	provider_id: number
	technology_code: number
	speed_bucket: string
	block_count: number
}

/**
 * The filing summary for a query includes `layer_manifest.sourceVintage`.
 *
 * `unknown_block_count` counts blocks without coverage and makes no statement about
 * whether providers file there.
 */
export interface FilingLandscape {
	vintage: string
	surveyed_block_count: number
	unknown_block_count: number
	/**
	 * The basis the surveyed blocks' coverage rows store, or `null` when no queried block is surveyed.
	 *
	 * A `source_present` basis records only that the source returned rows in the cell.
	 * A surveyed block with zero filings then shows that the source holds no record
	 * for it, and service there stays unknown.
	 */
	coverage_basis: CoverageBasis | null
	filings: ProviderFilingSummary[]
}

/**
 * `speed_bucket` label for a block whose `max_advertised_download_speed` is below
 * {@link BDC_SPEED_BUCKET_THRESHOLD_25_MBPS} Mbps.
 */
export const BDC_SPEED_BUCKET_UNDER_25 = "under-25"

/**
 * `speed_bucket` label for `BDC_SPEED_BUCKET_THRESHOLD_25_MBPS <= speed < BDC_SPEED_BUCKET_THRESHOLD_100_MBPS`.
 */
export const BDC_SPEED_BUCKET_25_100 = "25-100"

/**
 * `speed_bucket` label for `BDC_SPEED_BUCKET_THRESHOLD_100_MBPS <= speed < BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS`.
 */
export const BDC_SPEED_BUCKET_100_1000 = "100-1000"

/**
 * `speed_bucket` label for a block whose `max_advertised_download_speed` is at
 * or above {@link BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS} Mbps.
 */
export const BDC_SPEED_BUCKET_GIGABIT = "gigabit"

/**
 * Upper-exclusive Mbps boundary between {@link BDC_SPEED_BUCKET_UNDER_25}
 * and {@link BDC_SPEED_BUCKET_25_100}.
 */
export const BDC_SPEED_BUCKET_THRESHOLD_25_MBPS = 25

/**
 * Upper-exclusive Mbps boundary between {@link BDC_SPEED_BUCKET_25_100}
 * and {@link BDC_SPEED_BUCKET_100_1000}.
 */
export const BDC_SPEED_BUCKET_THRESHOLD_100_MBPS = 100

/**
 * Mbps boundary at or above which a block falls in {@link BDC_SPEED_BUCKET_GIGABIT}.
 */
export const BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS = 1000

/**
 * Return the speed bucket for a download speed in Mbps.
 * It must match {@link speedBucketCaseSQL}.
 */
export function speedBucketForDownloadSpeed(maxAdvertisedDownloadSpeed: number): string {
	if (maxAdvertisedDownloadSpeed < BDC_SPEED_BUCKET_THRESHOLD_25_MBPS) return BDC_SPEED_BUCKET_UNDER_25

	if (maxAdvertisedDownloadSpeed < BDC_SPEED_BUCKET_THRESHOLD_100_MBPS) return BDC_SPEED_BUCKET_25_100

	if (maxAdvertisedDownloadSpeed < BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS) return BDC_SPEED_BUCKET_100_1000

	return BDC_SPEED_BUCKET_GIGABIT
}

/**
 * SQL form of {@link speedBucketForDownloadSpeed}, so the query can group by bucket.
 */
const speedBucketCaseSQL = sql<string>`CASE
	WHEN max_advertised_download_speed < ${BDC_SPEED_BUCKET_THRESHOLD_25_MBPS} THEN ${BDC_SPEED_BUCKET_UNDER_25}
	WHEN max_advertised_download_speed < ${BDC_SPEED_BUCKET_THRESHOLD_100_MBPS} THEN ${BDC_SPEED_BUCKET_25_100}
	WHEN max_advertised_download_speed < ${BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS} THEN ${BDC_SPEED_BUCKET_100_1000}
	ELSE ${BDC_SPEED_BUCKET_GIGABIT}
END`

/**
 * Convert a stored res-9 cell to its res-6 coverage parent.
 */
export function res9ShortCellToRes6Parent(h3CellShortInt: number): number {
	return shortCellToParentInt(h3CellShortInt, BDC_H3_RESOLUTION, BDC_COVERAGE_H3_RESOLUTION)
}

/**
 * A block centroid's two cells: the res-9 short cell `bdc_availability.h3_cell` stores,
 * and its res-6 parent, the `layer_coverage` key.
 *
 * The builder and {@link geoidCellResolver} both call this function, and the parent
 * comes from {@link res9ShortCellToRes6Parent}, as the reader derives it.
 */
export function blockCentroidCells(centroid: { lat: number; lon: number }): { h3Cell: number; coverageCell: number } {
	const h3Cell = shortCellToInt(latLngToCell(centroid.lat, centroid.lon, BDC_H3_RESOLUTION) as H3Cell)

	return { h3Cell, coverageCell: res9ShortCellToRes6Parent(h3Cell) }
}

/**
 * A {@link FilingLandscapeQuery.resolveGeoidCell} over a block-centroid lookup.
 *
 * Pass the centroid source the database's build used, such as `createTIGERBlockCentroidLookup`.
 * A block the lookup cannot place stays unresolved, and the landscape counts it as unknown.
 */
export function geoidCellResolver(
	blockCentroids: (geoid: string) => { lat: number; lon: number } | null
): (geoid: string) => number | null {
	return (geoid) => {
		const centroid = blockCentroids(geoid)

		return centroid ? blockCentroidCells(centroid).h3Cell : null
	}
}

/**
 * Count provider filings by technology and speed bucket for a set of blocks.
 *
 * Blocks without coverage count as unknown and contribute no filings.
 */
export async function filingLandscape(
	db: DatabaseClient<BDCDatabase>,
	query: FilingLandscapeQuery
): Promise<FilingLandscape> {
	const queryModeCount = (query.geoids ? 1 : 0) + (query.h3Cells ? 1 : 0)

	if (queryModeCount !== 1) {
		throw new Error("filingLandscape: exactly one of `geoids` or `h3Cells` is required")
	}

	// An empty query would return an all-zero result that looks like a real answer.
	if (!(query.geoids ?? query.h3Cells)!.length) {
		throw new Error("filingLandscape: `geoids`/`h3Cells` must not be an empty array")
	}

	// The manifest read fails fast when the database has no manifest.
	const manifest = await readLayerManifest(db)

	const requestedUnits: ReadonlyArray<string | number> = query.geoids ?? query.h3Cells!
	const unitColumn = query.geoids ? ("geoid" as const) : ("h3_cell" as const)

	const candidateCellByUnit = new Map<string | number, number>()

	if (query.geoids) {
		const rows = await db
			.selectFrom("bdc_availability")
			.select(["geoid", "h3_cell"])
			.where("geoid", "in", query.geoids)
			.groupBy(["geoid", "h3_cell"])
			.execute()

		for (const row of rows) {
			candidateCellByUnit.set(row.geoid, row.h3_cell)
		}

		// A block with no rows of its own can still sit in a covered cell.
		// The resolver supplies that cell, so surveyed-empty is distinguished from unknown.
		if (query.resolveGeoidCell) {
			for (const geoid of query.geoids) {
				if (candidateCellByUnit.has(geoid)) continue

				const resolvedCell = query.resolveGeoidCell(geoid)

				if (resolvedCell !== null) {
					candidateCellByUnit.set(geoid, resolvedCell)
				}
			}
		}
	} else {
		for (const cell of query.h3Cells!) {
			candidateCellByUnit.set(cell, cell)
		}
	}

	let surveyedBlockCount = 0
	let unknownBlockCount = 0
	const surveyedUnits: Array<string | number> = []
	const bases = new Set<CoverageBasis>()

	for (const unit of requestedUnits) {
		const candidateCell = candidateCellByUnit.get(unit)

		if (candidateCell === undefined) {
			unknownBlockCount++

			continue
		}

		const res6Parent = res9ShortCellToRes6Parent(candidateCell)
		const coverage = await readLayerCoverage(db, res6Parent)

		if (coverage === null) {
			unknownBlockCount++
		} else {
			surveyedBlockCount++
			surveyedUnits.push(unit)
			bases.add(coverage.basis!)
		}
	}

	// One summary reports one basis.
	// Blocks whose coverage rows disagree on it need separate queries.
	if (bases.size > 1) {
		throw new Error(
			`filingLandscape: the surveyed blocks' coverage rows store ${bases.size} bases (${[...bases].join(", ")}); query them separately`
		)
	}

	let filings: ProviderFilingSummary[] = []

	if (surveyedUnits.length) {
		let filingsQuery = db
			.selectFrom("bdc_availability")
			.select([
				"provider_id",
				"technology_code",
				speedBucketCaseSQL.as("speed_bucket"),
				(eb) => eb.fn.count<number>(unitColumn).distinct().as("block_count"),
			])
			.groupBy(["provider_id", "technology_code", speedBucketCaseSQL])
			.orderBy("provider_id")
			.orderBy("technology_code")
			.orderBy(speedBucketCaseSQL)

		filingsQuery = query.geoids
			? filingsQuery.where("geoid", "in", surveyedUnits as string[])
			: filingsQuery.where("h3_cell", "in", surveyedUnits as number[])

		const filingsRows = await filingsQuery.execute()

		filings = filingsRows.map((row) => ({
			provider_id: row.provider_id,
			technology_code: row.technology_code,
			speed_bucket: row.speed_bucket,
			block_count: row.block_count,
		}))
	}

	return {
		vintage: manifest.sourceVintage,
		surveyed_block_count: surveyedBlockCount,
		unknown_block_count: unknownBlockCount,
		coverage_basis: [...bases][0] ?? null,
		filings,
	}
}
