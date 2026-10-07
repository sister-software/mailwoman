/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * House-number interpolation: when the exact address-point tier misses, estimate the coordinate from tiger street-segment ranges by parity-aware range match and linear interpolation along the segment polyline.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import type { InterpolationLookup } from "@mailwoman/core/resolver"
import { clampFraction, haversineKm, pointAlong } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { hasTable, prepareAll, type PreparedAll } from "#sqlite-utils"
import { canonicalizeRouteKey, type RouteKey, streetKeyVariants } from "#street/normalize"
import type { StreetSegmentDatabase } from "#street/segment-schema"

/**
 * How an interpolated answer was computed, `address_point` for bracketed neighbor points
 * and `tiger_range` for linear position within a tiger segment.
 */
export type InterpolationMethod = "address_point" | "tiger_range"

/**
 * One interpolated coordinate estimate, never an exact situs point.
 */
export interface InterpolatedHit {
	lat: number
	lon: number

	interpolated: true

	method: InterpolationMethod
	/**
	 * True when the matched segment side's parity agrees with the house number
	 * (or the side is `mixed`); false is an opposite-side fallback.
	 */
	parityMatched: boolean | null
	/**
	 * `both` sits between two known neighbor numbers; `single` is extrapolated from one side only.
	 */
	bracket: "both" | "single" | null
	/**
	 * Uncertainty radius in meters: half the matched segment length for `tiger_range`, half the
	 * bracket span for `address_point`/`both`, or a larger extrapolation penalty for `single`.
	 */
	uncertaintyM: number

	source: string

	release: string
}

export interface InterpolationQuery {
	street: string
	number: string
	/**
	 * ZIP scope.
	 * Without it common street names abstain.
	 */
	postcode?: string
	/**
	 * The resolved locality's coordinate, tie-breaking when no postcode was given
	 * and several postcodes survive parity.
	 */
	near?: { lat: number; lon: number }
}

/**
 * Acceptance geometry for the `near` tie-break: the winning group must be within this
 * many kilometers and the runner-up at least {@link NEAR_DOMINANCE} times farther.
 */
const NEAR_MAX_KM = 25

const NEAR_DOMINANCE = 2

interface SegmentRow {
	from_hn: number
	to_hn: number
	min_hn: number
	max_hn: number
	parity: string
	postcode: string | null
	geometry: string
	source: string
	release: string
}

/**
 * The postcode group nearest `near`, or null when no group qualifies within the dominance geometry.
 */
function nearestPostcodeGroup(pool: readonly SegmentRow[], near: { lat: number; lon: number }): SegmentRow[] | null {
	const groups = new Map<string, { rows: SegmentRow[]; km: number }>()

	for (const row of pool) {
		const key = row.postcode ?? ""
		let km = Number.POSITIVE_INFINITY

		try {
			const [firstVertex] = parseJSONStrict<[number, number][]>(row.geometry)

			if (firstVertex) {
				km = haversineKm(near.lat, near.lon, firstVertex[1], firstVertex[0])
			}
		} catch {
			// Unparseable geometry: this row cannot be sited, so it cannot win the tie-break.
		}

		const group = groups.get(key)

		if (group) {
			group.rows.push(row)
			group.km = Math.min(group.km, km)
		} else {
			groups.set(key, { rows: [row], km })
		}
	}

	const ranked = [...groups.values()].toSorted((a, b) => a.km - b.km)
	const [winner, runnerUp] = ranked

	if (!winner || winner.km > NEAR_MAX_KM) return null

	if (runnerUp && runnerUp.km < winner.km * NEAR_DOMINANCE) return null

	return winner.rows
}

export class StreetInterpolator<
	DB extends StreetSegmentDatabase = StreetSegmentDatabase,
> implements InterpolationLookup {
	readonly #db: DatabaseClient<DB>
	/**
	 * Resources this instance opened.
	 *
	 * A caller-supplied connection is not in here, so disposal cannot reach it.
	 */
	readonly #resources: DisposableStack
	readonly #byPostcode:
		| PreparedAll<[postcode: string, street: RouteKey, minNumber: number, maxNumber: number], SegmentRow>
		| undefined
	readonly #byStreet: PreparedAll<[street: RouteKey, minNumber: number, maxNumber: number], SegmentRow> | undefined
	readonly #radiusCalibration: number | null = null

	constructor(opts: { dbPath?: string; database?: DatabaseClient<DB> }) {
		using resources = new DisposableStack()

		if (opts.database) {
			this.#db = opts.database
		} else if (opts.dbPath) {
			this.#db = resources.use(new DatabaseClient<DB>(opts.dbPath, { readOnly: true }))
		} else {
			throw new Error("StreetInterpolator: one of dbPath or database is required")
		}

		// A tableless extract degrades to a no-op miss rather than a crash.
		if (hasTable(this.#db, "street_segment")) {
			const columns = `from_hn, to_hn, min_hn, max_hn, parity, postcode, geometry, source, release`

			this.#byPostcode = prepareAll(
				this.#db,
				`SELECT ${columns} FROM street_segment
				 WHERE postcode = ? AND street_norm = ? AND min_hn <= ? AND max_hn >= ?`
			)

			this.#byStreet = prepareAll(
				this.#db,
				`SELECT ${columns} FROM street_segment
				 WHERE street_norm = ? AND min_hn <= ? AND max_hn >= ?`
			)
		}

		// The conformal radius multiplier ships in the extract's `interp_calibration` table
		// and is read once at open time.
		// Extracts without that table leave it null.
		if (hasTable(this.#db, "interp_calibration")) {
			const row = this.#db.prepare("SELECT radius_multiplier FROM interp_calibration LIMIT 1").get() as
				| { radius_multiplier: unknown }
				| undefined

			const value = row?.radius_multiplier

			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				this.#radiusCalibration = value
			}
		}

		this.#resources = resources.move()
	}

	/**
	 * The artifact's own conformal radius multiplier, read from the extract at construction;
	 * `null` when the extract predates the table or contains no valid row.
	 */
	get radiusCalibration(): number | null {
		return this.#radiusCalibration
	}

	find(query: InterpolationQuery): InterpolatedHit | null {
		if (!this.#byPostcode || !this.#byStreet) return null
		const numberRaw = query.number.trim()

		// Strictly-numeric house numbers only.
		// The ranges do not model hyphenated or alphanumeric schemes.
		if (!/^\d+$/.test(numberRaw)) return null
		const n = Number(numberRaw)

		// A variant advances the ladder when it produces no answer rather than merely no rows.
		for (const variant of streetKeyVariants(query.street)) {
			const streetNorm = canonicalizeRouteKey(variant)

			// A ZIP that scopes to no candidate is a miss rather than a statewide guess.
			const rows = query.postcode
				? this.#byPostcode(query.postcode.trim(), streetNorm, n, n)
				: this.#byStreet(streetNorm, n, n)

			const hit = this.#answerFromRows(rows, n, query)

			if (hit) return hit
		}

		return null
	}

	/**
	 * Resolve one key variant's covering rows to an answer, or null when they cannot give one honestly.
	 */
	#answerFromRows(rows: SegmentRow[], n: number, query: InterpolationQuery): InterpolatedHit | null {
		if (!rows.length) return null

		// Parity preference: exact side first, then `mixed`, then the opposite side as a flagged fallback.
		const wantOdd = n % 2 === 1
		const exact = rows.filter((r) => r.parity === (wantOdd ? "odd" : "even"))
		const mixed = rows.filter((r) => r.parity === "mixed")
		const preferred = exact.length ? exact : mixed
		let pool = preferred.length ? preferred : rows
		const parityMatched = preferred.length > 0

		// Without a postcode the covering ranges must agree on one postcode
		// or the lookup abstains, counted over the parity pool.
		if (!query.postcode) {
			const postcodes = new Set(pool.map((r) => r.postcode ?? ""))

			if (postcodes.size > 1) {
				const scoped = query.near ? nearestPostcodeGroup(pool, query.near) : null

				if (!scoped) return null
				pool = scoped
			}
		}

		let best = pool[0]!

		for (const candidate of pool) {
			if (candidate.max_hn - candidate.min_hn < best.max_hn - best.min_hn) {
				best = candidate
			}
		}

		const polyline = parseJSONStrict<[number, number][]>(best.geometry)
		const span = best.to_hn - best.from_hn
		const t = span === 0 ? 0.5 : clampFraction((n - best.from_hn) / span)
		const [lon, lat, lengthKm] = pointAlong(polyline, t)

		return {
			lat,
			lon,
			interpolated: true,
			method: "tiger_range",
			parityMatched,
			bracket: null,
			uncertaintyM: Math.round((lengthKm * 1000) / 2),
			source: best.source,
			release: best.release,
		}
	}

	[Symbol.dispose](): void {
		this.#resources[Symbol.dispose]()
	}
}
