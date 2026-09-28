/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Node reader for `uprn.db`, where a `null` is evidence of absence only inside published coverage, so callers building negative evidence must consult `readLayerCoverage`.
 */

import { allRows } from "@mailwoman/core/utils"
import { haversineKm, shortCellToInt, type GeoCoordinate, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { gridDisk } from "h3-js"
import type { PathBuilderLike } from "path-ts"

import type { UPRNDatabase } from "#uprn/schema"
import { uprnFullCell } from "#uprn/schema"
/**
 * Conservative floor, in metres, on the centre distance one unit of res-9 grid distance buys, so multiplying a grid distance under-states reach and can never end the ring walk early.
 */
const RES9_CENTER_SPACING_FLOOR_M = 150

/**
 * Conservative ceiling, in metres, on a res-9 cell's centre-to-vertex distance, so a point within `radiusM` of the query sits in a cell whose centre is within `radiusM` plus this.
 */
const RES9_CELL_RADIUS_CEILING_M = 300

/**
 * Hard ceiling on `radiusM` that keeps the probe bounded, since a caller wanting a wider search than "which property is this coordinate" has outgrown this reader.
 */
export const UPRN_MAX_NEAREST_RADIUS_M = 10_000

/**
 * `IN`-list chunk size for the cell probe — far under SQLite's 32,766 bound-variable ceiling.
 */
const CELL_PROBE_CHUNK = 900

export interface UPRNNearestHit {
	uprn: number
	latitude: number
	longitude: number
	/**
	 * Haversine distance from the query point, metres.
	 */
	distanceM: number
}

export interface UPRNLookupOpts {
	/**
	 * Path to a `uprn.db` built by `mailwoman`'s gazetteer pipeline, opened read-only.
	 */
	databasePath?: PathBuilderLike
	/**
	 * Pre-opened handle (tests / shared connections), mutually exclusive with `databasePath`.
	 */
	database?: DatabaseClient<UPRNDatabase>
}

interface UPRNRow {
	uprn: number
	lat: number
	lon: number
}

/**
 * Node reader over `uprn.db`, disposable so callers can take it with `using`.
 */
export class UPRNLookup implements Disposable {
	#db: DatabaseClient<UPRNDatabase>
	/**
	 * Ownership is membership: a connection handed in by a caller is not in here, so disposal cannot reach it.
	 */
	readonly #resources = new DisposableStack()

	readonly #coordinateProbe: ReturnType<DatabaseClient["prepare"]>

	constructor(opts: UPRNLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
		} else if (opts.databasePath) {
			this.#db = this.#resources.use(new DatabaseClient<UPRNDatabase>(opts.databasePath, { readOnly: true }))
		} else {
			throw new Error("UPRNLookup needs `databasePath` or `database`")
		}

		this.#coordinateProbe = this.#db.prepare("SELECT lat, lon FROM uprn WHERE uprn = ?")
	}

	/**
	 * The WGS84 point OS publishes for `uprn`, or `null` when the layer holds no such uprn.
	 */
	coordinateOf(uprn: number): GeoCoordinate | null {
		const row = this.#coordinateProbe.get(uprn) as { lat: number; lon: number } | undefined

		return row ? { latitude: row.lat, longitude: row.lon } : null
	}

	/**
	 * The single nearest uprn within `radiusM` metres of the query point, or `null` when no uprn lies inside the radius.
	 *
	 * @throws {RangeError} When `radiusM` is not a positive finite number, or exceeds the cap.
	 */
	nearestUPRN(latitude: number, longitude: number, radiusM: number): UPRNNearestHit | null {
		if (!Number.isFinite(radiusM) || radiusM <= 0) {
			throw new RangeError(`nearestUPRN: radiusM must be a positive finite number, received ${radiusM}`)
		}

		if (radiusM > UPRN_MAX_NEAREST_RADIUS_M) {
			throw new RangeError(`nearestUPRN: radiusM ${radiusM} exceeds the ${UPRN_MAX_NEAREST_RADIUS_M} m cap`)
		}

		const origin = uprnFullCell(latitude, longitude)
		const seenCells = new Set<string>()
		let best: UPRNNearestHit | null = null

		// The loop terminates because the break bound is at most radiusM, which the RangeError above caps.
		for (let ring = 0; ; ring++) {
			// Once this bound exceeds the best hit so far, or the radius, no further ring can improve the answer.
			const closestPossibleM = ring * RES9_CENTER_SPACING_FLOOR_M - RES9_CELL_RADIUS_CEILING_M

			if (closestPossibleM > Math.min(radiusM, best?.distanceM ?? radiusM)) break

			const diskCells = gridDisk(origin, ring) as string[]
			const newCells: number[] = []

			for (const cell of diskCells) {
				if (!seenCells.has(cell)) {
					seenCells.add(cell)
					newCells.push(shortCellToInt(cell as H3Cell))
				}
			}

			for (let i = 0; i < newCells.length; i += CELL_PROBE_CHUNK) {
				const chunk = newCells.slice(i, i + CELL_PROBE_CHUNK)
				const placeholders = chunk.map(() => "?").join(", ")

				const rows = allRows<UPRNRow>(
					this.#db.prepare(`SELECT uprn, lat, lon FROM uprn WHERE h3_cell IN (${placeholders})`),
					...chunk
				)

				for (const row of rows) {
					const distanceM = haversineKm(latitude, longitude, row.lat, row.lon) * 1000

					if (distanceM <= radiusM && (best === null || distanceM < best.distanceM)) {
						best = { uprn: row.uprn, latitude: row.lat, longitude: row.lon, distanceM }
					}
				}
			}
		}

		return best
	}

	[Symbol.dispose](): void {
		this.#resources[Symbol.dispose]()
	}
}
