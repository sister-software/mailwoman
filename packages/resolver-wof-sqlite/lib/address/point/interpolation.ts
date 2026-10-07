/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Address-point interpolation, the second method of the resolution ladder. When the exact
 *   address-point tier misses a house number, bracket the number with real neighbor points on the
 *   same street and interpolate linearly in house-number space between them. Real occupancy
 *   replaces the tiger range tier's uniform-spacing assumption. Tiger range interpolation
 *   (`StreetInterpolator`) is the fallback for streets too sparse to bracket.
 *
 *   The matching key is `street_key`, the shared normalizer plus the route fold
 *   (`canonicalizeRouteKey`), identical at build time (`mailwoman situs address-points`) and query
 *   time by construction. Scope is postcode-first like the segment tier. A query without a postcode
 *   goes straight to the fallback. The fallback has its own statewide-ambiguity abstention.
 *
 *   Neighbor candidates never include the queried number itself, so production never overrides an
 *   on-file number and grading against the same extract is non-circular.
 *
 *   - Both-sided bracket (`bracket: "both"`): linear interpolation between the nearest known number
 *       below and above. `uncertaintyM` is half the distance between them.
 *   - Single-sided (`bracket: "single"`): linear extrapolation along the two nearest known numbers
 *       on that side, capped at one pair-span beyond the nearest point (`t ≤ 2`, past which the line
 *       provides no evidence and the query falls through). `uncertaintyM` is the pair distance plus
 *       the extrapolated overshoot, larger than the both-sided radius.
 *   - No bracket, meaning no neighbors, a single known number, or past the extrapolation cap: fall
 *       through to the tiger fallback when configured, else null.
 *
 *   Standalone like the segment tier, wired through the ordered `spatialTiers` list.
 */

import type { InterpolationLookup } from "@mailwoman/core/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { AddressPointDatabase } from "#address/point/schema"
import type { InterpolatedHit, InterpolationQuery, StreetInterpolator } from "#interpolation"
import { hasTable, prepareAll, type PreparedAll } from "#sqlite-utils"
import { canonicalizeRouteKey, type RouteKey, streetKeyVariants } from "#street/normalize"
/**
 * Extrapolation cap for a single-sided bracket: at most one pair-span beyond
 * the nearest known point (`t = 2`).
 *
 * Past it, the two-point line provides no evidence about the query number.
 */
const MAX_EXTRAPOLATION_T = 2

interface PointRow {
	n: number
	lat: number
	lon: number
	source: string
	release: string
}

/**
 * One known house number on the street: the centroid of its rows (unit siblings collapse).
 */
interface NumberAnchor {
	n: number
	lat: number
	lon: number
	source: string
	release: string
}

export class AddressPointInterpolator<
	DB extends AddressPointDatabase = AddressPointDatabase,
> implements InterpolationLookup {
	readonly #db: DatabaseClient<DB>
	/**
	 * Resources this instance opened.
	 *
	 * A connection handed in by a caller is not in here, so disposal cannot reach it.
	 * Ownership is membership rather than a flag a later branch checks.
	 */
	readonly #resources: DisposableStack
	readonly #fallback: StreetInterpolator | undefined
	readonly #byPostcode: PreparedAll<[postcode: string, street: RouteKey, number: number], PointRow> | undefined

	constructor(opts: { dbPath?: string; database?: DatabaseClient<DB>; fallback?: StreetInterpolator }) {
		using resources = new DisposableStack()

		if (opts.database) {
			this.#db = opts.database
		} else if (opts.dbPath) {
			this.#db = resources.use(new DatabaseClient<DB>(opts.dbPath, { readOnly: true }))
		} else {
			throw new Error("AddressPointInterpolator: one of dbPath or database is required")
		}

		this.#fallback = opts.fallback

		// Degrade gracefully on an extract without an `address_point` table.
		// The tier is skipped and defers to the segment fallback rather than crashing at construction.
		if (hasTable(this.#db, "address_point")) {
			this.#byPostcode = prepareAll(
				this.#db,
				`SELECT CAST(number AS INTEGER) AS n, lat, lon, source, release
				 FROM address_point
				 WHERE postcode = ? AND street_key = ?
					AND number GLOB '[0-9]*' AND number NOT GLOB '*[^0-9]*'
					AND CAST(number AS INTEGER) != ?`
			)
		}

		this.#resources = resources.move()
	}

	find(query: InterpolationQuery): InterpolatedHit | null {
		const numberRaw = query.number.trim()

		if (!/^\d+$/.test(numberRaw)) return null
		const n = Number(numberRaw)

		if (!this.#byPostcode || !query.postcode) return this.#fallback?.find(query) ?? null

		// Key-variant ladder (see `streetKeyVariants`), the same probe order as the exact-point reader.
		let rows: PointRow[] = []

		for (const variant of streetKeyVariants(query.street)) {
			const streetKey = canonicalizeRouteKey(variant)

			rows = this.#byPostcode(query.postcode.trim(), streetKey, n)

			if (rows.length) break
		}

		const hit = rows.length >= 2 ? interpolateFromNeighbors(rows, n) : null

		return hit ?? this.#fallback?.find(query) ?? null
	}

	[Symbol.dispose](): void {
		this.#resources[Symbol.dispose]()
	}
}

/**
 * Collapse rows to one centroid anchor per distinct house number, sorted ascending.
 */
function anchorsByNumber(rows: readonly PointRow[]): NumberAnchor[] {
	const byN = new Map<number, PointRow[]>()

	for (const row of rows) {
		const group = byN.get(row.n)

		if (group) {
			group.push(row)
		} else {
			byN.set(row.n, [row])
		}
	}

	return [...byN.entries()]
		.map(([n, group]) => ({
			n,
			lat: group.reduce((sum, r) => sum + r.lat, 0) / group.length,
			lon: group.reduce((sum, r) => sum + r.lon, 0) / group.length,
			source: group[0]!.source,
			release: group[0]!.release,
		}))
		.toSorted((a, b) => a.n - b.n)
}

function interpolateFromNeighbors(rows: readonly PointRow[], n: number): InterpolatedHit | null {
	const anchors = anchorsByNumber(rows)

	// Nearest known number below and above the query.
	// The rows never contain n itself.
	let below: NumberAnchor | null = null
	let above: NumberAnchor | null = null

	for (const anchor of anchors) {
		if (anchor.n < n) {
			below = anchor
		} else {
			above = anchor

			break
		}
	}

	if (below && above) {
		const t = (n - below.n) / (above.n - below.n)
		const spanM = haversineKm(below.lat, below.lon, above.lat, above.lon) * 1000

		return {
			lat: below.lat + (above.lat - below.lat) * t,
			lon: below.lon + (above.lon - below.lon) * t,
			interpolated: true,
			method: "address_point",
			bracket: "both",
			uncertaintyM: Math.round(spanM / 2),
			source: below.source,
			release: below.release,
		}
	}

	// Single-sided: extrapolate along the two nearest known numbers on the populated side.
	// `t > 1` by construction because n lies outside the span.
	const side = below ? anchors.slice(-2) : anchors.slice(0, 2)

	if (side.length < 2) return null
	const [far, near] = below ? [side[0]!, side[1]!] : [side[1]!, side[0]!]
	const t = (n - far.n) / (near.n - far.n)

	if (t > MAX_EXTRAPOLATION_T) return null

	const lat = far.lat + (near.lat - far.lat) * t
	const lon = far.lon + (near.lon - far.lon) * t
	const pairM = haversineKm(near.lat, near.lon, far.lat, far.lon) * 1000
	const overshootM = haversineKm(lat, lon, near.lat, near.lon) * 1000

	return {
		lat,
		lon,
		interpolated: true,
		method: "address_point",
		bracket: "single",
		// Explicitly larger than the both-sided radius: the whole pair span plus the overshoot.
		uncertaintyM: Math.round(pairM + overshootM),
		source: near.source,
		release: near.release,
	}
}
