/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Address-point interpolation — "Method 2" of the resolution ladder (#483, Phase 1 of
 *   `docs/articles/plan/2026-06-11-resolution-ladder.md`): when the exact address-point tier (#476)
 *   misses a house number, bracket the number with REAL neighbor points on the same street from the
 *   same #476 shard and interpolate linearly in house-number space between them. Real occupancy
 *   replaces TIGER's uniform-spacing assumption — the dominant error term of the TIGER pilot's gate
 *   miss; TIGER range interpolation (`StreetInterpolator`) demotes to the fallback for streets too
 *   sparse to bracket.
 *
 *   Matching key is `street_key` — THE shared normalizer plus the route fold
 *   (`canonicalizeRouteKey`), identical at build time (`scripts/build-address-point-shard.ts`) and
 *   query time, by construction. Scope is postcode-first like the segment tier; a query without a
 *   postcode goes straight to the fallback (which carries its own statewide-ambiguity abstention).
 *
 *   Bracketing contract:
 *
 *   - Neighbor candidates NEVER include the queried number itself (any unit/duplicate row of it) — in
 *       production the exact tier would already have answered an on-file number, and in the eval
 *       this is what makes grading against the same shard non-circular by construction.
 *   - Both-sided bracket (`bracket: "both"`): linear interpolation between the nearest known number
 *       below and above; `uncertaintyM` = half the distance between them.
 *   - Single-sided (`bracket: "single"`): linear extrapolation along the two nearest known numbers on
 *       that side, capped at one pair-span beyond the nearest point (`t ≤ 2` — beyond that the line
 *       carries no evidence and the query falls through); `uncertaintyM` = the pair distance plus
 *       the extrapolated overshoot, explicitly larger than the both-sided radius.
 *   - No bracket (no neighbors, a single known number, or past the extrapolation cap): fall through to
 *       the TIGER fallback when configured, else null.
 *
 *   Standalone like the segment tier — core wiring rides the Phase 2 ordered `spatialTiers` list.
 */

import { DatabaseSync } from "node:sqlite"

import type { InterpolationLookup } from "@mailwoman/resolver"

import { haversineKm } from "./geo.js"
import type { InterpolatedHit, InterpolationQuery, StreetInterpolator } from "./interpolation.js"
import { hasTable } from "./sqlite-utils.js"
import { canonicalizeRouteKey, normalizeStreetForKey } from "./street-normalize.js"

/**
 * Extrapolation cap for a single-sided bracket: at most one pair-span beyond the nearest known point (`t = 2`). Past
 * it, the two-point line carries no evidence about the query number.
 */
const MAX_EXTRAPOLATION_T = 2

interface PointRow {
	n: number
	lat: number
	lon: number
	source: string
	release: string
}

/** One known house number on the street: the centroid of its rows (unit siblings collapse). */
interface NumberAnchor {
	n: number
	lat: number
	lon: number
	source: string
	release: string
}

export class AddressPointInterpolator implements InterpolationLookup {
	readonly #db: DatabaseSync
	readonly #ownsDB: boolean
	readonly #fallback: StreetInterpolator | undefined
	readonly #byPostcode: ReturnType<DatabaseSync["prepare"]> | undefined

	constructor(opts: { dbPath?: string; database?: DatabaseSync; fallback?: StreetInterpolator }) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDB = false
		} else if (opts.dbPath) {
			this.#db = new DatabaseSync(opts.dbPath, { readOnly: true })
			this.#ownsDB = true
		} else {
			throw new Error("AddressPointInterpolator: one of dbPath or database is required")
		}
		this.#fallback = opts.fallback

		// Degrade gracefully on an empty/tableless shard (#568): with no `address_point` table this tier
		// is skipped, deferring to the segment fallback rather than crashing at construction.
		if (hasTable(this.#db, "address_point")) {
			// Strictly-numeric neighbor numbers on the route-folded street key within the ZIP. The
			// queried number itself is excluded HERE (see module doc: non-circular by construction).
			this.#byPostcode = this.#db.prepare(
				`SELECT CAST(number AS INTEGER) AS n, lat, lon, source, release
				 FROM address_point
				 WHERE postcode = ? AND street_key = ?
					AND number GLOB '[0-9]*' AND number NOT GLOB '*[^0-9]*'
					AND CAST(number AS INTEGER) != ?`
			)
		}
	}

	find(query: InterpolationQuery): InterpolatedHit | null {
		const streetKey = canonicalizeRouteKey(normalizeStreetForKey(query.street))
		const numberRaw = query.number.trim()

		if (!streetKey || !/^\d+$/.test(numberRaw)) return null
		const n = Number(numberRaw)

		// No own table (empty shard) or no postcode → defer to the segment fallback rather than query.
		if (!this.#byPostcode || !query.postcode) return this.#fallback?.find(query) ?? null

		const rows = this.#byPostcode.all(query.postcode.trim(), streetKey, n) as unknown as PointRow[]
		const hit = rows.length >= 2 ? interpolateFromNeighbors(rows, n) : null

		return hit ?? this.#fallback?.find(query) ?? null
	}

	close(): void {
		if (this.#ownsDB) this.#db.close()
	}
}

/** Collapse rows to one centroid anchor per distinct house number, sorted ascending. */
function anchorsByNumber(rows: readonly PointRow[]): NumberAnchor[] {
	const byN = new Map<number, PointRow[]>()

	for (const row of rows) {
		const group = byN.get(row.n)

		if (group) group.push(row)
		else byN.set(row.n, [row])
	}

	return [...byN.entries()]
		.map(([n, group]) => ({
			n,
			lat: group.reduce((sum, r) => sum + r.lat, 0) / group.length,
			lon: group.reduce((sum, r) => sum + r.lon, 0) / group.length,
			source: group[0]!.source,
			release: group[0]!.release,
		}))
		.sort((a, b) => a.n - b.n)
}

function interpolateFromNeighbors(rows: readonly PointRow[], n: number): InterpolatedHit | null {
	const anchors = anchorsByNumber(rows)

	// Nearest known number below and above the query (the rows never contain n itself).
	let below: NumberAnchor | undefined
	let above: NumberAnchor | undefined

	for (const anchor of anchors) {
		if (anchor.n < n) below = anchor
		else {
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
	// `near` is the anchor closest to n, `far` the next one out; t > 1 by construction.
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
