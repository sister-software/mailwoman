/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two phases between the streamed touches and the artifact a consumer reads: the stored containment
 *   index, and the reduction above it.
 *
 *   BOTH READ THE TOUCH TABLE, AND ONLY ONE OF THEM COMPACTS. `resolveCells` writes the tiers a probe walks
 *   and collapses uniform interiors parent-ward; `reduceCells` reads the UNCOMPACTED touches, because a
 *   compacted parent no longer names the cells the reduction has to answer.
 *
 *   THE REDUCTION IS THE SLOW PHASE AND ITS MEMORY IS BOUNDED BY CONSTRUCTION. A lattice of 49 point tests
 *   per sampled cell, over a delineation cache that is cleared whole rather than evicted one entry at a
 *   time — see {@link GEOMETRY_CACHE_ENTRIES}. Memory stays flat in row count, which is the property the poi
 *   build lost when a reader materialized instead of streaming.
 */

import type { DatabaseSync } from "@mailwoman/platform/sqlite"
import { expandH3Cell, shortCellToInt, type H3Cell, type H3CellShort } from "@mailwoman/spatial"
import { compactCells, getResolution } from "h3-js"

import { SoilCellContainment, type SoilCapabilityCellTable } from "../schema.ts"
import { mapUnitProfile, reduceCell, type CellCandidate, type MapUnitProfile } from "./reduce.ts"

/**
 * Resolve the touch table into the stored containment index.
 *
 * Compaction happens HERE and only on the whole side. It is expected to yield close to nothing on this layer, which is
 * the inversion the survey predicts: compaction needs a uniform interior, and 85.4% of `IA153`'s delineations are
 * smaller than one resolution-9 cell.
 */
export function resolveCells(
	database: DatabaseSync,
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

	// One group per (delineation, resolution): `compactCells` takes a single resolution, and an adaptively-indexed layer
	// has several. Pooling them throws; compacting only the target-resolution group would silently drop every coarsened
	// delineation's interior.
	database.exec("BEGIN")

	for (const { area_id: areaID, resolution } of groups) {
		const whole = database
			.prepare("SELECT DISTINCT h3_cell FROM build_cell_touch WHERE area_id = ? AND resolution = ? AND is_full = 1")
			.all(areaID, resolution) as Array<{ h3_cell: number }>

		for (const cell of compactCells(whole.map((row) => shortCellToLong(row.h3_cell, resolution)))) {
			const cellResolution = getResolution(cell)

			resolutions.add(cellResolution)
			insertCell.run(shortCellToInt(cell as H3Cell), cellResolution, areaID, SoilCellContainment.Whole)

			wholeRows++
		}
	}

	database.exec("COMMIT")

	// The partial rows are every touch that is not whole for its own delineation. `INSERT OR REPLACE` above already put
	// the whole rows in, and the primary key is `(h3_cell, area_id)`, so this insert must skip them explicitly rather
	// than rely on the key: a partial row replacing a whole one would demote an answered cell to a ray cast.
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
 * Cells reduced per progress report. The reduction is the slow phase — a lattice of 49 point tests per sampled cell —
 * so it reports often enough that a long run is visibly alive.
 */
const REDUCE_PROGRESS_STRIDE = 50_000

/**
 * One delineation's geometry, as the reduction reads it.
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
 * How many delineations the reduction keeps in memory at once.
 *
 * Sized to bound the phase rather than to hold everything: the pilot region's median delineation encodes to roughly 1.4
 * kB, so 200,000 of them is a few hundred megabytes — comfortable, and far below the 2.5 million a whole state holds.
 * Memory stays flat in row count, which is the property the poi build lost when a reader materialized instead of
 * streaming.
 */
const GEOMETRY_CACHE_ENTRIES = 200_000

/**
 * Reduce the touch table into `soil_capability_cell`.
 *
 * Reads the touch table rather than `soil_map_unit_cell` on purpose: the stored index is compacted on the whole side,
 * so a compacted parent no longer names the cells the reduction has to answer. The touch table is the uncompacted truth
 * about which delineation reaches which cell.
 */
export function reduceCells(
	database: DatabaseSync,
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

	// A delineation is named by every cell it reaches — 5.35 of them per cell at resolution 9 on the pilot region — so a
	// naive read fetches each ring blob once per touch. At Iowa's scale that is millions of blob reads of ground already
	// in memory. The cache is bounded and CLEARED WHOLE when it fills rather than evicted one at a time: h3 cell integers
	// carry their ancestry in their high bits, so a scan in `h3_cell` order visits neighbours together and a cleared cache
	// refills with the delineations the next run of cells actually names.
	const geometry = new Map<string, StoredDelineation>()

	database.exec("BEGIN")

	const flush = (): void => {
		if (currentCell === undefined || !candidates.length) return

		const cell = expandH3Cell(
			currentCell.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort,
			currentResolution
		) as H3Cell

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

		if (cells % REDUCE_PROGRESS_STRIDE === 0) {
			database.exec("COMMIT")
			database.exec("BEGIN")

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

	database.exec("COMMIT")

	return { cells, sampled, topClassUnderHalf, classless, unsampled, candidatePairs }
}

/**
 * Number of hex characters in a stored short cell — 52 bits.
 */
const SHORT_CELL_HEX_LENGTH = 13

function insertRow(statement: ReturnType<DatabaseSync["prepare"]>, row: SoilCapabilityCellTable): void {
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
 * Every map unit's per-unit-area profile, computed once and reused for every cell it reaches.
 */
function readMapUnitProfiles(database: DatabaseSync): Map<string, MapUnitProfile> {
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

/**
 * The full H3 index for a short cell stored at `resolution`.
 *
 * Through `expandH3Cell` rather than a string concatenation, because it VALIDATES: a short cell that does not name a
 * valid cell at the stated resolution throws here instead of reaching `compactCells` as a plausible-looking index.
 */
function shortCellToLong(shortCell: number, resolution: number): string {
	return expandH3Cell(shortCell.toString(16).padStart(SHORT_CELL_HEX_LENGTH, "0") as H3CellShort, resolution)
}
