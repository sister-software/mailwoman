/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turns the build's cell-touch table into the containment index and the per-cell capability reduction.
 */

import { expandShortCellInt, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { beginBatched } from "@mailwoman/sqlite/batched"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { compactCells, getResolution } from "h3-js"

import { SoilCellContainment, type SoilCapabilityCellTable, type SoilDatabase } from "#schema"
import { mapUnitProfile, reduceCell, type CellCandidate, type MapUnitProfile } from "#sdk/reduce"

/**
 * Writes the touch table into the `soil_map_unit_cell` containment index.
 *
 * Only whole cells are compacted.
 * Most soil delineations are smaller than one index cell, so compaction removes few rows on this layer.
 */
export function resolveCells(
	database: DatabaseClient<SoilDatabase>,
	indexResolution: number
): { wholeRows: number; partialRows: number; resolutions: number[] } {
	database.exec("CREATE INDEX build_cell_touch_area_cell ON build_cell_touch (area_id, resolution, is_full, h3_cell)")

	const groups = database
		.prepare("SELECT DISTINCT area_id, resolution FROM build_cell_touch WHERE is_full = 1")
		.all() as Array<{ area_id: string; resolution: number }>

	const insertCell = database.prepare(
		"INSERT OR REPLACE INTO soil_map_unit_cell (h3_cell, resolution, area_id, containment) VALUES (?, ?, ?, ?)"
	)

	const resolutions = new Set<number>()

	let wholeRows = 0

	// Each group is one delineation at one resolution, because `compactCells` throws on mixed resolutions.
	// Coarsened delineations are indexed at other resolutions, so every group must be compacted.
	database.exec("BEGIN")

	for (const { area_id: areaID, resolution } of groups) {
		const whole = database
			.prepare("SELECT DISTINCT h3_cell FROM build_cell_touch WHERE area_id = ? AND resolution = ? AND is_full = 1")
			.all(areaID, resolution) as Array<{ h3_cell: number }>

		for (const cell of compactCells(whole.map((row) => expandShortCellInt(row.h3_cell, resolution)))) {
			const cellResolution = getResolution(cell)

			resolutions.add(cellResolution)
			insertCell.run(shortCellToInt(cell as H3Cell), cellResolution, areaID, SoilCellContainment.Whole)

			wholeRows++
		}
	}

	database.exec("COMMIT")

	// The partial rows use `INSERT OR IGNORE` so that they never replace a whole row with the same key.
	// A replaced whole row would force the reader to ray-cast a cell it could answer directly.
	database.exec(
		"INSERT OR IGNORE INTO soil_map_unit_cell (h3_cell, resolution, area_id, containment) " +
			"SELECT DISTINCT t.h3_cell, t.resolution, t.area_id, 'partial' FROM build_cell_touch t WHERE t.is_full = 0"
	)

	const partialRows = (
		database.prepare("SELECT count(*) AS n FROM soil_map_unit_cell WHERE containment = 'partial'").get() as {
			n: number
		}
	).n

	for (const row of database.prepare("SELECT DISTINCT resolution FROM soil_map_unit_cell").all() as Array<{
		resolution: number
	}>) {
		resolutions.add(row.resolution)
	}

	resolutions.add(indexResolution)

	return { wholeRows, partialRows, resolutions: [...resolutions].toSorted((left, right) => left - right) }
}

/**
 * The number of cells reduced between progress reports and commits.
 */
const REDUCE_PROGRESS_STRIDE = 50_000

/**
 * One delineation's geometry as the reduction reads it.
 */
interface StoredDelineation {
	mukey: string
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	rings: Uint8Array
}

/**
 * The maximum number of delineations that the reduction keeps in memory.
 *
 * The limit keeps memory bounded when a state has millions of delineations.
 */
const GEOMETRY_CACHE_ENTRIES = 200_000

/**
 * Reduces the touch table into `soil_capability_cell`.
 *
 * It reads the touch table because `soil_map_unit_cell` is compacted, and a compacted
 * parent cell hides the index cells that the reduction must answer.
 */
export function reduceCells(
	database: DatabaseClient<SoilDatabase>,
	indexResolution: number,
	onProgress?: (message: string) => void
): {
	cells: number
	sampled: number
	topClassUnderHalf: number
	classless: number
	unsampled: number
	candidatePairs: number
} {
	const profiles = readMapUnitProfiles(database)

	const insert = database.prepare(
		"INSERT OR REPLACE INTO soil_capability_cell (h3_cell, class_shares, unrated_share, notrateable_share, nodata_share, other_share, mapped_share, top_class, top_class_share, weighting, delineations) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	)

	const selectArea = database.prepare(
		"SELECT mukey, min_lat, min_lon, max_lat, max_lon, rings FROM soil_map_unit_area WHERE area_id = ?"
	)

	const rows = database
		.prepare("SELECT h3_cell, resolution, area_id, is_full FROM build_cell_touch ORDER BY resolution, h3_cell, area_id")
		.iterate() as Iterable<{ h3_cell: number; resolution: number; area_id: string; is_full: number }>

	let cells = 0
	let sampled = 0
	let topClassUnderHalf = 0
	let classless = 0
	let unsampled = 0
	let candidatePairs = 0

	let currentCell: number | undefined
	let currentResolution = indexResolution
	let candidates: CellCandidate[] = []

	// Each delineation touches several cells, so the cache avoids reading its rings once per touch.
	// The cache is cleared whole when it fills.
	// The scan runs in `h3_cell` order and visits neighbouring cells together.
	// After a clear, the cache refills with the delineations that the next cells need.
	const geometry = new Map<string, StoredDelineation>()

	const batch = beginBatched(database, { rowsPerCommit: REDUCE_PROGRESS_STRIDE })

	const flush = (): void => {
		if (currentCell === undefined || !candidates.length) return

		const cell = expandShortCellInt(currentCell, currentResolution)

		const reducedCell = reduceCell(cell, currentResolution, candidates, profiles, currentCell)

		candidatePairs += candidates.length

		if (reducedCell.row.mapped_share <= 0) {
			unsampled++

			return
		}

		cells++

		if (reducedCell.sampled) {
			sampled++
		}

		if (reducedCell.topClassUnderHalf) {
			topClassUnderHalf++
		}

		if (!reducedCell.row.top_class) {
			classless++
		}

		insertRow(insert, reducedCell.row)

		if (batch.rowWritten()) {
			onProgress?.(`${cells.toLocaleString()} cells reduced`)
		}
	}

	for (const row of rows) {
		if (row.h3_cell !== currentCell || row.resolution !== currentResolution) {
			flush()

			currentCell = row.h3_cell
			currentResolution = row.resolution
			candidates = []
		}

		let area = geometry.get(row.area_id)

		if (!area) {
			area = selectArea.get(row.area_id) as StoredDelineation | undefined

			if (!area) {
				throw new Error(
					`soil build: the touch table names delineation ${row.area_id}, which soil_map_unit_area does not hold — the ingest and the reduction disagree about what was written`
				)
			}

			if (geometry.size >= GEOMETRY_CACHE_ENTRIES) {
				geometry.clear()
			}

			geometry.set(row.area_id, area)
		}

		candidates.push({
			areaID: row.area_id,
			mukey: area.mukey,
			containment: row.is_full ? SoilCellContainment.Whole : SoilCellContainment.Partial,
			minLat: area.min_lat,
			minLon: area.min_lon,
			maxLat: area.max_lat,
			maxLon: area.max_lon,
			rings: area.rings,
		})
	}

	flush()

	batch.commit()

	return { cells, sampled, topClassUnderHalf, classless, unsampled, candidatePairs }
}

function insertRow(statement: ReturnType<DatabaseClient["prepare"]>, row: SoilCapabilityCellTable): void {
	statement.run(
		row.h3_cell,
		row.class_shares,
		row.unrated_share,
		row.notrateable_share,
		row.nodata_share,
		row.other_share,
		row.mapped_share,
		row.top_class,
		row.top_class_share,
		row.weighting,
		row.delineations
	)
}

/**
 * Computes every map unit's profile once so that each cell reuses it.
 */
function readMapUnitProfiles(database: DatabaseClient<SoilDatabase>): Map<string, MapUnitProfile> {
	const componentsByMukey = new Map<
		string,
		Array<{ comppct_r: number; compkind: string | null; nirrcapcl: string | null }>
	>()

	for (const row of database
		.prepare("SELECT mukey, comppct_r, compkind, nirrcapcl FROM soil_component")
		.all() as Array<{ mukey: string; comppct_r: number; compkind: string | null; nirrcapcl: string | null }>) {
		const list = componentsByMukey.get(row.mukey)

		if (list) {
			list.push(row)
		} else {
			componentsByMukey.set(row.mukey, [row])
		}
	}

	const profiles = new Map<string, MapUnitProfile>()

	for (const row of database.prepare("SELECT mukey, no_mapping FROM soil_map_unit").all() as Array<{
		mukey: string
		no_mapping: number
	}>) {
		profiles.set(row.mukey, mapUnitProfile(row, componentsByMukey.get(row.mukey) ?? []))
	}

	return profiles
}
