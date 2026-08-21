/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader for `uprn.db` — the OS Open UPRN layer (`uprn-schema.ts`). Two probes:
 *
 *   - **`coordinateOf(uprn)`**: rowid B-tree hit on the `uprn` integer PK.
 *   - **`nearestUPRN(lat, lon, radiusM)`**: bounded nearest-point search over the res-9 `h3_cell`
 *     index — ring-by-ring `gridDisk` expansion with chunked `IN` probes and haversine ranking.
 *     Rings stop as soon as geometry proves no unprobed cell could beat the best hit — a distance
 *     bound, not POILookup's row-count accumulation, so the early exit can never strand a nearer
 *     point in an unprobed ring.
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

import { allRows } from "./sqlite-utils.ts"
import { uprnFullCell } from "./uprn-schema.ts"

/**
 * Conservative FLOOR on how much CENTRE distance one unit of res-9 GRID distance buys, metres. Adjacent centres sit √3
 * × edge apart (avg edge 174.4 m → ≈302 m); the worst bearing across a ring costs a further ×0.866, and H3's projection
 * distortion shrinks edges by well under the slack this leaves (the true worst is ≈217 m per grid step). Dividing a
 * radius by this over-counts rings and can never miss a cell; multiplying a grid distance by it under-states reach and
 * can never end the ring walk early.
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
	 * Bounded two ways: `radiusM` is capped at {@link UPRN_MAX_NEAREST_RADIUS_M}, and rings expand outward only until no
	 * unprobed cell could beat the best hit found so far (or the radius, when nothing has been found). The stop rule is
	 * geometric — a cell at grid distance `g` holds no point nearer than `g` × spacing floor − cell radius, using the
	 * same conservative constants the reach math uses — so unlike POILookup's row-count accumulation there is no
	 * early-exit ambiguity: a break can never strand a nearer point in an unprobed ring. This is what keeps a
	 * capped-radius call over dense ground at milliseconds instead of a full-disk fetch (measured 6.4 s → 13 ms for a 10
	 * km radius over central London, 41.6M-row layer; an empty-sea miss at the cap runs the full expansion, 74 ms).
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

		// `ring` is H3 grid distance; the loop terminates because the break bound is at most radiusM, which the
		// RangeError above caps.
		for (let ring = 0; ; ring++) {
			// A cell at grid distance `ring` holds no point nearer than this. Once it exceeds what could still
			// win — the best hit so far, or the radius itself — further rings cannot improve the answer.
			const closestPossibleM = ring * RES9_CENTER_SPACING_FLOOR_M - RES9_CELL_RADIUS_CEILING_M

			if (closestPossibleM > Math.min(radiusM, best?.distanceM ?? radiusM)) break

			// gridDisk(origin, ring) returns the WHOLE disk out to `ring`; diffing against what's already been
			// probed derives just this ring's new cells (the POILookup pattern).
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

				// Prepared fresh per chunk arity — a cold, per-call path, same posture as POILookup's batched hydration.
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

	close(): void {
		if (this.#ownsDB) {
			this.#db.close()
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
