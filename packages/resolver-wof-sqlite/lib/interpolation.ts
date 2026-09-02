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
 *   Reads the per-state extract built by `scripts/build-interpolation-extract.ts` (`street_segment`: one
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

import { parseJSONStrict } from "@mailwoman/core/objects"
import type { InterpolationLookup } from "@mailwoman/resolver"
import { clampFraction, haversineKm, pointAlong } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { hasTable, prepareAll, type PreparedAll } from "#sqlite-utils"
import { canonicalizeRouteKey, type RouteKey, streetKeyVariants } from "#street/normalize"
import type { StreetSegmentDatabase } from "#street/segment-schema"

/**
 * How an interpolated answer was computed (#483 Method 2):
 *
 * - `address_point` — bracketed/extrapolated between REAL neighbor points from the #476 extract
 *   (`AddressPointInterpolator`), replacing TIGER's uniform-spacing assumption with occupancy.
 * - `tiger_range` — linear position within a TIGER segment's theoretical house-number range (`StreetInterpolator`), the
 *   fallback for streets too sparse to bracket.
 */
export type InterpolationMethod = "address_point" | "tiger_range"

/**
 * One interpolated coordinate estimate. Never an exact situs point — see `uncertaintyM`.
 */
export interface InterpolatedHit {
	lat: number
	lon: number
	/**
	 * Always true — the tier's honesty flag, mirrored into `resolution_tier` when wired.
	 */
	interpolated: true
	/**
	 * Which rung answered — see {@link InterpolationMethod}.
	 */
	method: InterpolationMethod
	/**
	 * `tiger_range` only. True when the matched segment side's parity agrees with the house number (or the side is
	 * `mixed`). False = opposite-side fallback: usually the right block, wrong side of the street.
	 */
	parityMatched?: boolean
	/**
	 * `address_point` only. `both` = the query number sits between two known neighbor numbers; `single` = neighbors exist
	 * on one side only (extrapolated, larger `uncertaintyM`).
	 */
	bracket?: "both" | "single"
	/**
	 * Honest uncertainty radius in meters: half the matched segment's polyline length (`tiger_range`), half the bracket
	 * span (`address_point`/`both`), or the explicitly larger extrapolation penalty (`address_point`/`single`).
	 */
	uncertaintyM: number
	/**
	 * Provenance, e.g. `"tiger:edges"`.
	 */
	source: string
	/**
	 * Pinned data vintage, e.g. `"TIGER2023"`.
	 */
	release: string
}

export interface InterpolationQuery {
	street: string
	number: string
	/**
	 * ZIP scope — strongly preferred; without it common street names abstain (see module doc).
	 */
	postcode?: string
	/**
	 * The resolved locality's coordinate — the tie-breaker when no postcode was given and the parity-preferred covering
	 * ranges still span several postcodes. See {@link NEAR_MAX_KM} for the acceptance geometry.
	 */
	near?: { lat: number; lon: number }
}

/**
 * Acceptance geometry for the `near` tie-break: the winning postcode group's closest segment must sit within this many
 * kilometres of `near`, AND the runner-up group must be at least {@link NEAR_DOMINANCE} times farther. Both measured on
 * the two live failures: Brooklyn's `st pauls place` 11226 segment is ~2 km from the Brooklyn centroid with Great
 * Neck's 11021 at ~24 km (12×); Fraser's `east 13 mile road` 48026 is ~2 km with Mecosta's namesake ~190 km away. A
 * near-tie between groups is genuine ambiguity and stays an abstention.
 */
const NEAR_MAX_KM = 25

/**
 * See {@link NEAR_MAX_KM}.
 */
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
 * The postcode group nearest `near`, under the {@link NEAR_MAX_KM} dominance geometry — or null when no group qualifies
 * (out of range, or the runner-up is too close to call). A group's distance is its closest segment's first polyline
 * vertex; a segment whose geometry fails to parse prices as unreachable rather than aborting the tie-break.
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
	 * Resources this instance opened. A connection handed in by a caller is NOT in here, so disposal cannot reach it —
	 * ownership is membership rather than a flag a later branch has to check.
	 */
	readonly #resources = new DisposableStack()
	readonly #byPostcode:
		| PreparedAll<[postcode: string, street: RouteKey, minNumber: number, maxNumber: number], SegmentRow>
		| undefined
	readonly #byStreet: PreparedAll<[street: RouteKey, minNumber: number, maxNumber: number], SegmentRow> | undefined
	readonly #radiusCalibration: number | undefined

	constructor(opts: { dbPath?: string; database?: DatabaseClient<DB> }) {
		if (opts.database) {
			this.#db = opts.database
		} else if (opts.dbPath) {
			this.#db = this.#resources.use(new DatabaseClient<DB>(opts.dbPath, { readOnly: true }))
		} else {
			throw new Error("StreetInterpolator: one of dbPath or database is required")
		}

		// Degrade gracefully on an empty/tableless extract (interrupted build, stray 0-byte file): with no
		// `street_segment` table this interpolator is a no-op miss, not a crash that loses the state (#568).
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

		// #374 doctrine: the conformal radius multiplier is a property of the calibration set the ARTIFACT was
		// built against, so it ships in the extract's `interp_calibration` metadata table (street-segment-schema.ts)
		// and is read here, once, at open time — sync raw `.prepare()` per the sync-by-interface doctrine
		// (AGENTS.md). Extracts predating the table (the pre-2026-07 fleet) yield `undefined`; callers then fall
		// back to their in-code table, byte-identically.
		if (hasTable(this.#db, "interp_calibration")) {
			const row = this.#db.prepare("SELECT radius_multiplier FROM interp_calibration LIMIT 1").get() as
				| { radius_multiplier: unknown }
				| undefined

			const value = row?.radius_multiplier

			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				this.#radiusCalibration = value
			}
		}
	}

	/**
	 * The artifact's own conformal radius multiplier (#374), read from the extract's `interp_calibration` metadata table
	 * at construction. `undefined` = the extract predates the table (or carries no valid row) — the resolver then applies
	 * no artifact default and callers may supply a legacy fallback.
	 */
	get radiusCalibration(): number | undefined {
		return this.#radiusCalibration
	}

	find(query: InterpolationQuery): InterpolatedHit | null {
		if (!this.#byPostcode || !this.#byStreet) return null
		const numberRaw = query.number.trim()

		// Strictly-numeric house numbers only — this tier estimates, it doesn't guess at
		// hyphenated/alphanumeric schemes the ranges don't model.
		if (!/^\d+$/.test(numberRaw)) return null
		const n = Number(numberRaw)

		// Key-variant ladder (see `streetKeyVariants`): the literal key first, then the doubled-type
		// collapse and the saint↔st register swap. A variant advances the ladder when it produces no
		// ANSWER, not merely no rows — a wrong-register key can cover the number in far-away towns and
		// then fail the ambiguity check ("saint pauls place" reaches Nassau's rows; the Brooklyn answer
		// lives under "st pauls place"), and stopping at rows would eclipse the right variant.
		for (const variant of streetKeyVariants(query.street)) {
			const streetNorm = canonicalizeRouteKey(variant)

			// A given ZIP that scopes to nothing is a MISS, not a statewide guess: the retry was
			// measured (2026-06-11 VT eval) at +2.3pp coverage for a poisoned tail (p99 1.0 → 20.8
			// km, max 204 km — a unique name statewide can live in a far-away town).
			const rows = query.postcode
				? this.#byPostcode(query.postcode.trim(), streetNorm, n, n)
				: this.#byStreet(streetNorm, n, n)

			const hit = this.#answerFromRows(rows, n, query)

			if (hit) return hit
		}

		return null
	}

	/**
	 * Resolve one key variant's covering rows to an answer, or null when they cannot honestly give one — the
	 * parity/ambiguity/tightest-range pipeline the module doc describes.
	 */
	#answerFromRows(rows: SegmentRow[], n: number, query: InterpolationQuery): InterpolatedHit | null {
		if (!rows.length) return null

		// Parity preference: exact side first, then 'mixed' (matches either), then the
		// opposite side as a flagged fallback.
		const wantOdd = n % 2 === 1
		const exact = rows.filter((r) => r.parity === (wantOdd ? "odd" : "even"))
		const mixed = rows.filter((r) => r.parity === "mixed")
		const preferred = exact.length ? exact : mixed
		let pool = preferred.length ? preferred : rows
		const parityMatched = preferred.length > 0

		// No scope given: the covering ranges must agree on ONE postcode or the lookup abstains — a
		// name spanning towns is ambiguity, not an answer. Counted over the PARITY pool, not all
		// rows: a section-line boundary road carries a different ZIP per side ("east 13 mile road"
		// is Fraser 48026 odd / Roseville 48066 even), and the opposite side can never hold the
		// number it would otherwise veto. When several postcodes survive parity, the caller's
		// resolved-locality coordinate breaks the tie by segment proximity under the dominance
		// geometry of {@link NEAR_MAX_KM} — a near-tie stays an abstention.
		if (!query.postcode) {
			const postcodes = new Set(pool.map((r) => r.postcode ?? ""))

			if (postcodes.size > 1) {
				const scoped = query.near ? nearestPostcodeGroup(pool, query.near) : null

				if (!scoped) return null
				pool = scoped
			}
		}

		// Tightest range wins — the most specific claim about where this number lives.
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
			uncertaintyM: Math.round((lengthKm * 1000) / 2),
			source: best.source,
			release: best.release,
		}
	}

	[Symbol.dispose](): void {
		this.#resources[Symbol.dispose]()
	}
}
