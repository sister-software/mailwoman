/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader for `uprn.db` — the OS Open UPRN layer (`uprn-schema.ts`). Two probes:
 *
 *   - **`coordinateOf(uprn)`**: rowid B-tree hit on the `uprn` integer PK.
 *   - **`nearestUPRN(lat, lon, radiusM)`**: bounded nearest-point search over the res-9 `h3_cell`
 *     index — one `gridDisk` of rings sized from the radius, one chunked `IN` probe, haversine to
 *     rank. NOT the POILookup ring-by-ring accumulation loop: this search wants the single nearest
 *     point inside a hard radius, so there is no early-exit ambiguity — every cell that could hold a
 *     candidate is probed, exactly once.
 *
 *   ## `null` is a claim, scoped by coverage
 *
 *   OS designates Open UPRN complete for GB (every UPRN in AddressBase Premium with geometry), and
 *   the builder writes `layer_coverage` with basis `designated` for every cell the product touches.
 *   So a `null` from either probe inside a covered cell is evidence of absence — "no such published
 *   GB UPRN" / "no UPRN within the radius". Outside coverage (Northern Ireland, the Isle of Man, the
 *   Channel Islands, open water) it is UNKNOWN, per the meaning-of-zero rule — callers building
 *   negative evidence must consult `readLayerCoverage`, not this reader alone.
 *
 *   `latLngToCell`/`gridDisk` come from `h3-js`; the 48-bit short-cell packing is
 *   `@mailwoman/spatial`'s `shortCellToInt` via `uprnFullCell` — never reimplemented here.
 */

import { DatabaseSync } from "node:sqlite"

import { haversineKm, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { gridDisk } from "h3-js"

import { uprnFullCell } from "./uprn-schema.ts"

/**
 * Conservative FLOOR on the centre-to-centre spacing of adjacent res-9 cells, metres. The true spacing is √3 × edge
 * (avg edge 174.4 m → ≈302 m), and H3's projection distortion never squeezes it near 150 — so dividing by this
 * over-counts rings, which costs a few empty index probes and can never miss a cell.
 */
const RES9_CENTER_SPACING_FLOOR_M = 150

/**
 * Conservative CEILING on a res-9 cell's centre-to-vertex distance, metres (avg edge 174.4 m; distortion stays well
 * under this). A point within `radiusM` of the query sits in a cell whose CENTRE is within `radiusM` + this.
 */
const RES9_CELL_RADIUS_CEILING_M = 300

/**
 * Hard ceiling on `radiusM`. Keeps the probe bounded (10 km → ~72 rings ≈ 15.8k cells ≈ 18 `IN` chunks); a caller who
 * wants a wider search than "which property is this coordinate" has outgrown this reader and should say so loudly.
 */
export const UPRN_MAX_NEAREST_RADIUS_M = 10_000

/**
 * `IN`-list chunk size for the cell probe — far under SQLite's 32,766 bound-variable ceiling.
 */
const CELL_PROBE_CHUNK = 900

export interface UPRNCoordinate {
	latitude: number
	longitude: number
}

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
	 * Path to a `uprn.db` built by `mailwoman`'s gazetteer pipeline. Opened read-only.
	 */
	databasePath?: string
	/**
	 * Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`.
	 */
	database?: DatabaseSync
}

interface UPRNRow {
	uprn: number
	lat: number
	lon: number
}

/**
 * Node reader over `uprn.db`. `implements Disposable` so callers can `using lookup = new UPRNLookup(...)` — the same
 * precedent as {@link POILookup}.
 */
export class UPRNLookup implements Disposable {
	#db: DatabaseSync
	#ownsDB: boolean

	/**
	 * `uprn` → its point (rowid-alias PK hit).
	 */
	readonly #coordinateProbe: ReturnType<DatabaseSync["prepare"]>

	constructor(opts: UPRNLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDB = false
		} else if (opts.databasePath) {
			this.#db = new DatabaseSync(opts.databasePath, { readOnly: true })
			this.#ownsDB = true
		} else {
			throw new Error("UPRNLookup needs `databasePath` or `database`")
		}

		this.#coordinateProbe = this.#db.prepare("SELECT lat, lon FROM uprn WHERE uprn = ?")
	}

	/**
	 * The WGS84 point OS publishes for `uprn`, or `null` when the layer holds no such UPRN (see the module docstring for
	 * what that `null` claims).
	 */
	coordinateOf(uprn: number): UPRNCoordinate | null {
		const row = this.#coordinateProbe.get(uprn) as { lat: number; lon: number } | undefined

		return row ? { latitude: row.lat, longitude: row.lon } : null
	}

	/**
	 * The single nearest UPRN within `radiusM` metres of the query point, or `null` when no UPRN lies inside the radius.
	 *
	 * Bounded: the ring count derives from `radiusM` (conservatively, so a candidate just inside the radius but across a
	 * distorted cell boundary is never missed), and `radiusM` itself is capped at {@link UPRN_MAX_NEAREST_RADIUS_M}.
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

		// Every res-9 cell whose CENTRE lies within radiusM + cellRadius of the query can hold a point within
		// radiusM; the ring count that certainly reaches all such centres is that distance over the spacing floor.
		const rings = Math.ceil((radiusM + RES9_CELL_RADIUS_CEILING_M) / RES9_CENTER_SPACING_FLOOR_M)
		const origin = uprnFullCell(latitude, longitude)
		const cells = (gridDisk(origin, rings) as string[]).map((cell) => shortCellToInt(cell as H3Cell))

		let best: UPRNNearestHit | null = null

		for (let i = 0; i < cells.length; i += CELL_PROBE_CHUNK) {
			const chunk = cells.slice(i, i + CELL_PROBE_CHUNK)
			const placeholders = chunk.map(() => "?").join(", ")

			// Prepared fresh per chunk arity — a cold, per-call path, same posture as POILookup's batched hydration.
			const rows = this.#db
				.prepare(`SELECT uprn, lat, lon FROM uprn WHERE h3_cell IN (${placeholders})`)
				.all(...chunk) as unknown as UPRNRow[]

			for (const row of rows) {
				const distanceM = haversineKm(latitude, longitude, row.lat, row.lon) * 1000

				if (distanceM <= radiusM && (best === null || distanceM < best.distanceM)) {
					best = { uprn: row.uprn, latitude: row.lat, longitude: row.lon, distanceM }
				}
			}
		}

		return best
	}

	close(): void {
		if (this.#ownsDB) {
			this.#db.close()
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
