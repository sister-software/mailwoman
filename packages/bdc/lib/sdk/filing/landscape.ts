/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the `filing_landscape` summary from a BDC database.
 *
 *   A queried block counts as surveyed only when its res-6 parent cell appears in `layer_coverage`;
 *   anything else is unknown, which is different from a surveyed block with zero filings. A GEOID
 *   query takes each block's res-9 cell from its `bdc_availability` rows, so a GEOID without rows is
 *   unknown; an `h3Cells` query supplies the cell, so a covered cell with no rows reports as
 *   surveyed with zero filings.
 *
 *   The res-6 parent comes from the stored res-9 cell, as it does in `build-bdc.ts`; recomputing it
 *   from the block centroid disagrees for some points because H3 cells do not nest exactly.
 */

import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import { shortCellToParentInt } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

import { BDC_COVERAGE_H3_RESOLUTION, BDC_H3_RESOLUTION, type BDCDatabase } from "#schema"

/**
 * Query for {@link filingLandscape}; set exactly one of `geoids` or `h3Cells`.
 */
export interface FilingLandscapeQuery {
	geoids?: string[]
	h3Cells?: number[]
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
 * Filing summary for a query, stamped with `layer_manifest.sourceVintage`.
 *
 * `unknown_block_count` counts blocks without coverage and makes no statement about
 * whether providers file there.
 */
export interface FilingLandscape {
	vintage: string
	surveyed_block_count: number
	unknown_block_count: number
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
 * Return the speed bucket for a download speed in Mbps; it must match {@link speedBucketCaseSQL}.
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
 * Count provider filings by technology and speed bucket for a set of blocks;
 * blocks without coverage count as unknown and contribute no filings.
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

	// Reading the manifest first fails fast on a database without one.
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
	} else {
		for (const cell of query.h3Cells!) {
			candidateCellByUnit.set(cell, cell)
		}
	}

	let surveyedBlockCount = 0
	let unknownBlockCount = 0
	const surveyedUnits: Array<string | number> = []

	for (const unit of requestedUnits) {
		const candidateCell = candidateCellByUnit.get(unit)

		if (candidateCell === undefined) {
			unknownBlockCount++

			continue
		}

		const res6Parent = res9ShortCellToRes6Parent(candidateCell)
		const coverage = await readLayerCoverage(db, res6Parent)

		if (coverage === undefined) {
			unknownBlockCount++
		} else {
			surveyedBlockCount++
			surveyedUnits.push(unit)
		}
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
		filings,
	}
}
