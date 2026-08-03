/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `filing_landscape` reader — the FOUR PRE-REGISTERED ACCEPTANCE GATES this whole phase
 *   is judged by. See `filing-landscape.test.ts` for the gate tests; this module is only the reader.
 *
 *   Coverage check (the meaning-of-zero rule): a queried block counts as SURVEYED only when its res-6
 *   coverage cell is present in `layer_coverage` (via `readLayerCoverage`) — `undefined` means the area
 *   was never surveyed, and the block is reported in `unknown_block_count`, NEVER folded into a
 *   zero-filing claim.
 *
 *   - For a `geoids` query, the candidate res-9 cell is read off the block's OWN `bdc_availability`
 *     rows — a geoid with zero rows has no derivable cell at all (never guessed, matching the builder's
 *     "unknown geoid" discipline in `build-bdc.ts`), so it falls straight to unknown.
 *   - For an `h3Cells` query, the caller supplies the res-9 cell directly, so coverage can be checked
 *     even for a cell with no filing rows of its own — a genuine "surveyed, zero providers here" result,
 *     the meaning-of-zero rule's POSITIVE case (covered but empty is not the same as never surveyed).
 *
 *   Res-9 → res-6 parent reconstruction is deliberately NOT `@mailwoman/spatial`'s `expandH3Cell` — that
 *   helper's left-shift reconstruction only round-trips a short cell that was shortened AT resolution
 *   15 (the address-id spine); fed a resolution-9 short cell it silently produces a full index
 *   `cellToParent` rejects (`Cell arguments had incompatible resolutions`), verified empirically while
 *   building this reader. The correct reconstruction for a short cell captured at a KNOWN resolution R
 *   is a straight concatenation, not a shift: a full 64-bit H3 cell index is always
 *   `"8" + <resolution nibble> + <52 bits of base-cell + digit path, trailing padding included>`, and
 *   the 48-bit "short" form (`shortCellToInt`/`shortenH3Cell`) already carries exactly those low 52 bits
 *   verbatim — so `"8" + R.toString(16) + shortHex.padStart(13, "0")` reassembles the identical full
 *   index `latLngToCell` would have produced at resolution R. See {@link res9ShortCellToRes6Parent}.
 *
 *   This same formula is exactly what `build-bdc.ts` MUST use (and does, after fix round 1) to derive the
 *   coverage cell it writes at build time — H3's cell hierarchy is not geometrically exact, so a
 *   `latLngToCell(centroid, 6)` computed independently of the stored res-9 cell disagrees with
 *   `cellToParent(res9Cell, 6)` for a real fraction of points (verified ~6% over CONUS). Builder and
 *   reader deriving the res-6 parent differently was a real bug: a genuinely-surveyed block
 *   (real rows, real `layer_coverage` entry) could read back as `unknown_block_count` while its own rows
 *   still populated `filings` — a self-contradiction. `filings` is now scoped to units that PASS the
 *   coverage check (see the `surveyedUnits` accumulator below) precisely so that can't happen again: a
 *   block excluded from `surveyed_block_count` never contributes to `filings` either.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent } from "h3-js"
import { sql, type Kysely } from "kysely"

import { BDC_COVERAGE_H3_RESOLUTION, BDC_H3_RESOLUTION, type BDCDatabase } from "../schema.ts"

/**
 * Exactly one of `geoids` or `h3Cells` is required — `filingLandscape` throws otherwise.
 */
export interface FilingLandscapeQuery {
	geoids?: string[]
	h3Cells?: number[]
}

/**
 * One provider/technology/speed-bucket group's block count within the query — `block_count` is the number of DISTINCT
 * queried blocks carrying this exact combination, never a raw row count. A block can carry multiple `bdc_availability`
 * rows for the SAME (provider_id, technology_code) pair even in the DEFAULT (non-`includeLocationIDs`) build mode:
 * `build-bdc.ts`'s materialize-time collapse merges to one row per distinct (geoid, provider_id, technology_code,
 * speeds, low_latency, business_residential_code) tuple, not one row per (geoid, provider_id, technology_code) triple —
 * so Broadband Serviceable Locations at the same triple with DIFFERING speeds/flags survive as separate rows and can
 * land in different `speed_bucket`s here (see that file's docstring). This `block_count`'s DISTINCT is exactly what
 * keeps that from double-counting the block itself when it does.
 */
export interface ProviderFilingSummary {
	provider_id: number
	technology_code: number
	speed_bucket: string
	block_count: number
}

/**
 * The queried landscape: ALWAYS vintage-stamped (from `layer_manifest.sourceVintage`) and ALWAYS reports its unknown
 * blocks — `unknown_block_count` is reported, never zeroed, and never evidence of "no providers file here."
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
 * `speed_bucket` label for a block whose `max_advertised_download_speed` is at or above
 * {@link BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS} Mbps.
 */
export const BDC_SPEED_BUCKET_GIGABIT = "gigabit"

/**
 * Upper-exclusive Mbps boundary between {@link BDC_SPEED_BUCKET_UNDER_25} and {@link BDC_SPEED_BUCKET_25_100}.
 */
export const BDC_SPEED_BUCKET_THRESHOLD_25_MBPS = 25

/**
 * Upper-exclusive Mbps boundary between {@link BDC_SPEED_BUCKET_25_100} and {@link BDC_SPEED_BUCKET_100_1000}.
 */
export const BDC_SPEED_BUCKET_THRESHOLD_100_MBPS = 100

/**
 * Mbps boundary at/above which a block is bucketed {@link BDC_SPEED_BUCKET_GIGABIT}.
 */
export const BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS = 1000

/**
 * Pure mirror of the SQL `CASE` expression below ({@link speedBucketCaseSQL}) — same thresholds, same labels, exported
 * so the boundary logic can be asserted directly without a database round trip.
 */
export function speedBucketForDownloadSpeed(maxAdvertisedDownloadSpeed: number): string {
	if (maxAdvertisedDownloadSpeed < BDC_SPEED_BUCKET_THRESHOLD_25_MBPS) return BDC_SPEED_BUCKET_UNDER_25

	if (maxAdvertisedDownloadSpeed < BDC_SPEED_BUCKET_THRESHOLD_100_MBPS) return BDC_SPEED_BUCKET_25_100

	if (maxAdvertisedDownloadSpeed < BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS) return BDC_SPEED_BUCKET_100_1000

	return BDC_SPEED_BUCKET_GIGABIT
}

/**
 * The same bucketing as {@link speedBucketForDownloadSpeed}, expressed as a `CASE` over `max_advertised_download_speed`
 * so the GROUP BY below can group directly on the bucket.
 */
const speedBucketCaseSQL = sql<string>`CASE
	WHEN max_advertised_download_speed < ${BDC_SPEED_BUCKET_THRESHOLD_25_MBPS} THEN ${BDC_SPEED_BUCKET_UNDER_25}
	WHEN max_advertised_download_speed < ${BDC_SPEED_BUCKET_THRESHOLD_100_MBPS} THEN ${BDC_SPEED_BUCKET_25_100}
	WHEN max_advertised_download_speed < ${BDC_SPEED_BUCKET_THRESHOLD_GIGABIT_MBPS} THEN ${BDC_SPEED_BUCKET_100_1000}
	ELSE ${BDC_SPEED_BUCKET_GIGABIT}
END`

/**
 * `BDCDatabase extends LayerContractDatabase` structurally, but Kysely's `transaction()` makes `Kysely<DB>` INVARIANT
 * in `DB` — same narrowing cast as `build-bdc.ts`'s `asContractDB`.
 */
function asContractDB(kdb: DatabaseClient<BDCDatabase>): Kysely<LayerContractDatabase> {
	return kdb as unknown as Kysely<LayerContractDatabase>
}

/**
 * Reconstruct the res-6 ancestor of a res-9 short-cell int WITHOUT a centroid — see the module docstring for why this
 * isn't `@mailwoman/spatial`'s `expandH3Cell`. Exported so tests can assert this agrees, cell-for-cell, with
 * `build-bdc.ts`'s own coverage-cell derivation (the two MUST share this exact formula — see that file's docstring).
 */
export function res9ShortCellToRes6Parent(h3CellShortInt: number): number {
	const shortHex = h3CellShortInt.toString(16).padStart(13, "0")
	const fullCell = `8${BDC_H3_RESOLUTION.toString(16)}${shortHex}` as H3Cell
	const parentCell = cellToParent(fullCell, BDC_COVERAGE_H3_RESOLUTION) as H3Cell

	return shortCellToInt(parentCell)
}

/**
 * Read the provider/technology/speed-bucket filing census over a set of queried blocks (by `geoid` or by `h3Cell`,
 * never both). Always vintage-stamped; always throws on a broken manifest rather than answering unstamped; a queried
 * block with no coverage evidence is reported in `unknown_block_count` and never folded into a zero-filing claim.
 */
export async function filingLandscape(
	db: DatabaseClient<BDCDatabase>,
	query: FilingLandscapeQuery
): Promise<FilingLandscape> {
	const queryModeCount = (query.geoids ? 1 : 0) + (query.h3Cells ? 1 : 0)

	if (queryModeCount !== 1) {
		throw new Error("filingLandscape: exactly one of `geoids` or `h3Cells` is required")
	}

	// `[]` is truthy, so it passes the XOR check above undetected — without this guard an empty array sails
	// straight through to a vacuous all-zero landscape (surveyed_block_count: 0, unknown_block_count: 0, no
	// filings), which reads exactly like a real "nothing queried" answer instead of the malformed-query error
	// it should be. Checked before the manifest read so a bad query fails fast without even opening the db further.
	if (!(query.geoids ?? query.h3Cells)!.length) {
		throw new Error("filingLandscape: `geoids`/`h3Cells` must not be an empty array")
	}

	// Read (and validate) the manifest FIRST — a broken/missing manifest must throw before any block is
	// classified, never fall through to an "unstamped" answer (gate 4).
	const manifest = await readLayerManifest(asContractDB(db))

	const requestedUnits: ReadonlyArray<string | number> = query.geoids ?? query.h3Cells!
	const unitColumn = query.geoids ? ("geoid" as const) : ("h3_cell" as const)

	// Candidate res-9 cell per requested unit. `h3Cells` queries already carry the cell directly;
	// `geoids` queries can only derive one from the block's OWN rows — a geoid with none has no
	// candidate at all (never guessed), so it falls straight to unknown below.
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
	// Only units that PASS the coverage check feed the census below — a unit with rows but no coverage evidence
	// (a corrupted/inconsistent db — see filing-landscape.test.ts's "coverage row deleted" gate) is `unknown`, and
	// its rows must not leak into `filings` either: `surveyed_block_count` and the blocks backing `filings` must
	// always agree, or a caller cross-referencing the two gets a contradiction (an "unknown" block whose filings
	// still show up looks exactly like the false-negative bug this reader exists to prevent).
	const surveyedUnits: Array<string | number> = []

	for (const unit of requestedUnits) {
		const candidateCell = candidateCellByUnit.get(unit)

		if (candidateCell === undefined) {
			unknownBlockCount++

			continue
		}

		const res6Parent = res9ShortCellToRes6Parent(candidateCell)
		const coverage = await readLayerCoverage(asContractDB(db), res6Parent)

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
