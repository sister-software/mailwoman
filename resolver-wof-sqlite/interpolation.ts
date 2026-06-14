/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   House-number interpolation (#483): when the exact address-point tier (#476, `address-point.ts`)
 *   misses, estimate the coordinate from TIGER street-segment ranges — parity-aware range match,
 *   then linear interpolation along the segment polyline. Design:
 *   `docs/articles/plan/2026-06-11-interpolation-design.md`.
 *
 *   Reads the per-state shard built by `scripts/build-interpolation-shard.ts` (`street_segment`: one
 *   row per TIGER edge SIDE — independent left/right ranges, ZIPs, parity). Query-side
 *   normalization is THE shared normalizer (`street-normalize.ts`) — identical to build-side, by
 *   construction.
 *
 *   Every answer is honest about being an estimate: `interpolated: true`, `parityMatched` (false when
 *   only the opposite side's range contained the number — usually the right block, wrong side of
 *   the street), and `uncertaintyM` (half the matched segment's length — the #483 issue's honest
 *   default). Scoping is postcode-first (a given ZIP that scopes to nothing is a MISS — the
 *   statewide retry was measured and rejected, see `find()`); without a postcode the statewide name
 *   match must agree on a single postcode or the lookup ABSTAINS (a common street name spanning
 *   towns is ambiguity, not an answer).
 *
 *   Standalone in this slice — core tier wiring (`resolution_tier: "interpolated"` after the
 *   exact-point fall-through) is a noted follow-up on #483, so the `find()` shape mirrors
 *   `AddressPointLookup.find()` to keep that wiring mechanical.
 */

import { DatabaseSync } from "node:sqlite"

import type { InterpolationLookup } from "@mailwoman/core/resolver"

import { haversineKm } from "./geo.js"
import { hasTable } from "./sqlite-utils.js"
import { canonicalizeRouteKey, normalizeStreetForKey } from "./street-normalize.js"

/**
 * How an interpolated answer was computed (#483 Method 2):
 *
 * - `address_point` — bracketed/extrapolated between REAL neighbor points from the #476 shard
 *   (`AddressPointInterpolator`), replacing TIGER's uniform-spacing assumption with occupancy.
 * - `tiger_range` — linear position within a TIGER segment's theoretical house-number range
 *   (`StreetInterpolator`), the fallback for streets too sparse to bracket.
 */
export type InterpolationMethod = "address_point" | "tiger_range"

/** One interpolated coordinate estimate. Never an exact situs point — see `uncertaintyM`. */
export interface InterpolatedHit {
	lat: number
	lon: number
	/** Always true — the tier's honesty flag, mirrored into `resolution_tier` when wired. */
	interpolated: true
	/** Which rung answered — see {@link InterpolationMethod}. */
	method: InterpolationMethod
	/**
	 * `tiger_range` only. True when the matched segment side's parity agrees with the house number
	 * (or the side is `mixed`). False = opposite-side fallback: usually the right block, wrong side
	 * of the street.
	 */
	parityMatched?: boolean
	/**
	 * `address_point` only. `both` = the query number sits between two known neighbor numbers;
	 * `single` = neighbors exist on one side only (extrapolated, larger `uncertaintyM`).
	 */
	bracket?: "both" | "single"
	/**
	 * Honest uncertainty radius in meters: half the matched segment's polyline length
	 * (`tiger_range`), half the bracket span (`address_point`/`both`), or the explicitly larger
	 * extrapolation penalty (`address_point`/`single`).
	 */
	uncertaintyM: number
	/** Provenance, e.g. `"tiger:edges"`. */
	source: string
	/** Pinned data vintage, e.g. `"TIGER2023"`. */
	release: string
}

export interface InterpolationQuery {
	street: string
	number: string
	/** ZIP scope — strongly preferred; without it common street names abstain (see module doc). */
	postcode?: string
}

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

export class StreetInterpolator implements InterpolationLookup {
	readonly #db: DatabaseSync
	readonly #ownsDb: boolean
	readonly #byPostcode: ReturnType<DatabaseSync["prepare"]> | undefined
	readonly #byStreet: ReturnType<DatabaseSync["prepare"]> | undefined

	constructor(opts: { dbPath?: string; database?: DatabaseSync }) {
		if (opts.database) {
			this.#db = opts.database
			this.#ownsDb = false
		} else if (opts.dbPath) {
			this.#db = new DatabaseSync(opts.dbPath, { readOnly: true })
			this.#ownsDb = true
		} else {
			throw new Error("StreetInterpolator: one of dbPath or database is required")
		}
		// Degrade gracefully on an empty/tableless shard (interrupted build, stray 0-byte file): with no
		// `street_segment` table this interpolator is a no-op miss, not a crash that loses the state (#568).
		if (hasTable(this.#db, "street_segment")) {
			const columns = `from_hn, to_hn, min_hn, max_hn, parity, postcode, geometry, source, release`
			this.#byPostcode = this.#db.prepare(
				`SELECT ${columns} FROM street_segment
				 WHERE postcode = ? AND street_norm = ? AND min_hn <= ? AND max_hn >= ?`
			)
			this.#byStreet = this.#db.prepare(
				`SELECT ${columns} FROM street_segment
				 WHERE street_norm = ? AND min_hn <= ? AND max_hn >= ?`
			)
		}
	}

	find(query: InterpolationQuery): InterpolatedHit | null {
		if (!this.#byPostcode || !this.#byStreet) return null
		const streetNorm = canonicalizeRouteKey(normalizeStreetForKey(query.street))
		const numberRaw = query.number.trim()
		// Strictly-numeric house numbers only — this tier estimates, it doesn't guess at
		// hyphenated/alphanumeric schemes the ranges don't model.
		if (!streetNorm || !/^\d+$/.test(numberRaw)) return null
		const n = Number(numberRaw)

		let rows: SegmentRow[]
		if (query.postcode) {
			// A given ZIP that scopes to nothing is a MISS, not a statewide guess: the retry was
			// measured (2026-06-11 VT eval) at +2.3pp coverage for a poisoned tail (p99 1.0 → 20.8
			// km, max 204 km — a unique name statewide can live in a far-away town).
			rows = this.#byPostcode.all(query.postcode.trim(), streetNorm, n, n) as unknown as SegmentRow[]
		} else {
			// No scope given: a name matching ranges across several ZIPs is ambiguous — abstain.
			rows = this.#byStreet.all(streetNorm, n, n) as unknown as SegmentRow[]
			const postcodes = new Set(rows.map((r) => r.postcode ?? ""))
			if (postcodes.size > 1) return null
		}
		if (rows.length === 0) return null

		// Parity preference: exact side first, then 'mixed' (matches either), then the
		// opposite side as a flagged fallback.
		const wantOdd = n % 2 === 1
		const exact = rows.filter((r) => r.parity === (wantOdd ? "odd" : "even"))
		const mixed = rows.filter((r) => r.parity === "mixed")
		const preferred = exact.length > 0 ? exact : mixed
		const pool = preferred.length > 0 ? preferred : rows
		const parityMatched = preferred.length > 0

		// Tightest range wins — the most specific claim about where this number lives.
		const best = pool.reduce((a, b) => (b.max_hn - b.min_hn < a.max_hn - a.min_hn ? b : a))

		const polyline = JSON.parse(best.geometry) as [number, number][]
		const span = best.to_hn - best.from_hn
		const t = span === 0 ? 0.5 : clamp01((n - best.from_hn) / span)
		const [lon, lat, lengthKm] = pointAlong(polyline, t)
		return {
			lat,
			lon,
			interpolated: true,
			method: "tiger_range",
			parityMatched,
			uncertaintyM: Math.round((lengthKm * 1000) / 2),
			source: best.source,
			release: best.release,
		}
	}

	close(): void {
		if (this.#ownsDb) this.#db.close()
	}
}

function clamp01(t: number): number {
	return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Point at fraction `t` of the polyline's total arc length (haversine), plus the total length in
 * km. `t` is assumed clamped to [0, 1].
 */
function pointAlong(polyline: readonly [number, number][], t: number): [lon: number, lat: number, lengthKm: number] {
	const legs: number[] = []
	let total = 0
	for (let i = 1; i < polyline.length; i++) {
		const [aLon, aLat] = polyline[i - 1]!
		const [bLon, bLat] = polyline[i]!
		const d = haversineKm(aLat, aLon, bLat, bLon)
		legs.push(d)
		total += d
	}
	if (total === 0) {
		const [lon, lat] = polyline[0]!
		return [lon, lat, 0]
	}
	let remaining = t * total
	for (let i = 0; i < legs.length; i++) {
		const leg = legs[i]!
		if (remaining <= leg || i === legs.length - 1) {
			const f = leg === 0 ? 0 : clamp01(remaining / leg)
			const [aLon, aLat] = polyline[i]!
			const [bLon, bLat] = polyline[i + 1]!
			return [aLon + (bLon - aLon) * f, aLat + (bLat - aLat) * f, total]
		}
		remaining -= leg
	}
	const [lon, lat] = polyline[polyline.length - 1]!
	return [lon, lat, total]
}
