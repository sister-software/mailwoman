/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reverse geocoding (#484): `(lat, lon)` → the containing admin hierarchy. Assembly over existing
 *   machinery, per the 2026-06-11 scoping notes:
 *
 *   1. **Candidate fetch** — the admin DB's `place_bbox` R*Tree (built by `fts.ts`) for places whose
 *        bbox contains the point, smallest-area-first (so the FIRST polygon confirmation is the
 *        deepest).
 *   2. **PIP confirmation** — ray-cast (geo.ts, the canonical TS port of
 *        `scripts/eval/pip-containment.py`) against the polygon sidecar DB (`wof-polygons.db`,
 *        `polygons(id, geom)` with GeoJSON text — built by `scripts/build-wof-polygons.mjs` for the
 *        demo map). A candidate whose polygon EXISTS but rejects the point is a bbox false positive
 *        and is dropped entirely; a candidate with no polygon row stays eligible for the approximate
 *        fallback.
 *   3. **Approximate descent** — WOF carries point geometry for most localities (#292: ~99% of JP
 *        municipalities; ~half of US localities have degenerate bboxes too), so the polygon walk
 *        usually bottoms out at county level. We then descend tier-by-tier (county → localadmin →
 *        locality → …) through the winner's DESCENDANTS (the `ancestors` table, reversed), taking
 *        the PIP-confirmed child when a polygon exists and the nearest-centroid child otherwise —
 *        the latter flagged `containment: "approximate"`, the demo's honesty convention.
 *   4. **Hierarchy assembly** — the deepest place's ancestor chain via the SAME walk forward
 *        resolution uses (`ancestry.ts`, #404), so consumers get a symmetric tree.
 *
 *   Reverse quality is country-dependent (polygon coverage: see the #292 JP finding); `containment`
 *   says so per result rather than pretending.
 */

import { DatabaseSync } from "node:sqlite"

import { ancestorLineage, placetypeDepth } from "./ancestry.js"
import { PLACE_BBOX_TABLE } from "./fts.js"
import { geometryContains, haversineKm, type GeojsonGeometry } from "./geo.js"
import type { PlaceCandidate, WofPlacetype } from "./types.js"

/**
 * How the deepest returned place was confirmed:
 *
 * - `"polygon"` — the point ray-cast INSIDE the place's real (DP-simplified) admin boundary.
 * - `"approximate"` — the place has no polygon on record; it won by nearest-centroid among the
 *   candidates whose bbox (or parent) contains the point. The same honesty convention as the demo's
 *   approximate circles — country-dependent data reality, surfaced instead of hidden.
 */
export type ContainmentKind = "polygon" | "approximate"

export interface ReverseGeocodeResult {
	/**
	 * The containment chain, DEEPEST-FIRST (`[0]` is the winning place, then its ancestors up to
	 * country) — the same tree shape forward resolution attaches via `includeAncestors`. Empty when
	 * no candidate's bbox contains the point (open ocean, or outside the gazetteer's coverage).
	 */
	hierarchy: PlaceCandidate[]
	/** Containment kind of the DEEPEST place in `hierarchy` (see {@link ContainmentKind}). */
	containment: ContainmentKind
}

export interface WofReverseGeocoderOpts {
	/**
	 * Path to the admin gazetteer DB (e.g. `admin-global-priority.db`) — must carry `spr`,
	 * `ancestors`, and the package-built `place_bbox` R*Tree (`mailwoman-wof-build-fts`). Mutually
	 * exclusive with `adminDatabase`.
	 */
	adminDbPath?: string
	/** Pre-opened admin DB — primarily for tests against an inline fixture. */
	adminDatabase?: DatabaseSync
	/**
	 * Path to the polygon sidecar DB (`wof-polygons.db`, table `polygons(id, geom)`). OPTIONAL —
	 * without it every result is `containment: "approximate"` (centroid-only mode). Mutually
	 * exclusive with `polygonDatabase`.
	 */
	polygonDbPath?: string
	/** Pre-opened polygon DB — primarily for tests. */
	polygonDatabase?: DatabaseSync
}

export interface ReverseGeocodeOpts {
	/**
	 * Restrict the hierarchy to these placetypes (both the bbox candidates and the descent tiers).
	 * Default: every admin placetype the gazetteer carries. E.g. `["region", "county", "locality"]`
	 * to skip the neighbourhood grain.
	 */
	placetypes?: WofPlacetype[]
	/**
	 * Cap on the bbox candidate fetch. Default 128 — comfortably covers a dense metro (the most
	 * bbox-overlapping point we've measured is a few dozen neighbourhoods + the admin chain).
	 */
	maxCandidates?: number
	/**
	 * Approximate (nearest-centroid) steps further than this from the query point are not taken —
	 * keeps a sparse gazetteer from "refining" to a far-away sibling. Polygon-confirmed steps ignore
	 * it (containment is exact regardless of centroid distance). Default 25 km.
	 */
	maxApproximateKm?: number
}

const DEFAULT_MAX_CANDIDATES = 128
const DEFAULT_MAX_APPROXIMATE_KM = 25

/**
 * The tier ladder for the approximate descent, coarsest-first. Each tier is attempted among the
 * CURRENT winner's descendants; a tier with no rows is skipped (e.g. counties without localadmins
 * jump straight to locality).
 */
const DESCENT_TIERS: readonly WofPlacetype[] = [
	"county",
	"localadmin",
	"locality",
	"borough",
	"neighbourhood",
	"microhood",
]

/** Internal candidate row off `spr` (+ optional bbox area / centroid distance bookkeeping). */
interface CandidateRow {
	id: number
	name: string
	placetype: string
	country: string | null
	parent_id: number | null
	lat: number
	lon: number
}

function toPlaceCandidate(row: CandidateRow, distanceKm?: number): PlaceCandidate {
	const c: PlaceCandidate = {
		id: row.id,
		name: row.name,
		placetype: row.placetype as WofPlacetype,
		country: row.country ?? "",
		lat: row.lat,
		lon: row.lon,
		parent_id: row.parent_id ?? undefined,
		score: 0,
	}
	if (distanceKm !== undefined) c.distanceKm = distanceKm
	return c
}

export class WofReverseGeocoder implements Disposable {
	readonly #admin: DatabaseSync
	readonly #ownsAdmin: boolean
	readonly #polygons: DatabaseSync | null
	readonly #ownsPolygons: boolean
	/**
	 * Parsed-geometry cache. Reverse queries cluster geographically (an eval run hits the same ~15
	 * county polygons 1400 times), so caching the JSON.parse pays for itself immediately. Bounded —
	 * cleared wholesale at the cap rather than LRU-tracked; the polygons are DP-simplified and small,
	 * the cap exists only to keep a long-lived server process honest.
	 */
	readonly #geometryCache = new Map<number, GeojsonGeometry | null>()
	static readonly #GEOMETRY_CACHE_CAP = 4096

	constructor(opts: WofReverseGeocoderOpts) {
		if (opts.adminDatabase && opts.adminDbPath) {
			throw new Error("WofReverseGeocoder: pass either `adminDatabase` or `adminDbPath`, not both")
		}
		if (!opts.adminDatabase && !opts.adminDbPath) {
			throw new Error("WofReverseGeocoder: one of `adminDatabase` or `adminDbPath` is required")
		}
		if (opts.polygonDatabase && opts.polygonDbPath) {
			throw new Error("WofReverseGeocoder: pass either `polygonDatabase` or `polygonDbPath`, not both")
		}

		this.#admin = opts.adminDatabase ?? new DatabaseSync(opts.adminDbPath!, { readOnly: true })
		this.#ownsAdmin = !opts.adminDatabase
		this.#polygons = opts.polygonDatabase ?? (opts.polygonDbPath ? new DatabaseSync(opts.polygonDbPath, { readOnly: true }) : null)
		this.#ownsPolygons = !opts.polygonDatabase && Boolean(opts.polygonDbPath)

		// Fail loudly up front — the R*Tree is a build artifact, not part of the upstream WOF
		// distribution, and a missing index would otherwise surface as an opaque SQL error per query.
		const hasBbox = this.#admin
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(PLACE_BBOX_TABLE)
		if (!hasBbox) {
			throw new Error(
				`WofReverseGeocoder: the admin DB has no \`${PLACE_BBOX_TABLE}\` R*Tree. Build it with ` +
					"`mailwoman-wof-build-fts <path-to-wof.db>` (see resolver-wof-sqlite/README.md)."
			)
		}
		if (this.#polygons) {
			const hasPolygons = this.#polygons
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'polygons'`)
				.get()
			if (!hasPolygons) {
				throw new Error(
					"WofReverseGeocoder: the polygon DB has no `polygons` table. Expected a `wof-polygons.db` " +
						"built by scripts/build-wof-polygons.mjs."
				)
			}
		}
	}

	/**
	 * Resolve a WGS-84 point to its containing admin hierarchy. Async for symmetry with
	 * `PlaceLookup.findPlace` (the work is sync `node:sqlite` underneath — same convention).
	 */
	async reverseGeocode(lat: number, lon: number, opts: ReverseGeocodeOpts = {}): Promise<ReverseGeocodeResult> {
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
			throw new RangeError(`WofReverseGeocoder.reverseGeocode: (${lat}, ${lon}) is not a WGS-84 coordinate`)
		}
		const maxApproximateKm = opts.maxApproximateKm ?? DEFAULT_MAX_APPROXIMATE_KM
		const candidates = this.#bboxCandidates(lat, lon, opts)

		// PIP walk, smallest-bbox-first: the first polygon that contains the point is the deepest
		// polygon-confirmable place. Polygon-rejected candidates are bbox false positives — dropped.
		let winner: CandidateRow | null = null
		let winnerConfirmed = false
		const pointOnly: CandidateRow[] = []
		for (const c of candidates) {
			const contains = geometryContains(this.#geometry(c.id), lon, lat)
			if (contains === true) {
				winner = c
				winnerConfirmed = true
				break
			}
			if (contains === null) pointOnly.push(c)
		}

		if (!winner) {
			// No polygon confirmed anywhere — nearest centroid among the polygon-less bbox candidates.
			let bestKm = Infinity
			for (const c of pointOnly) {
				const km = haversineKm(lat, lon, c.lat, c.lon)
				if (km < bestKm) {
					bestKm = km
					winner = c
				}
			}
			if (!winner) return { hierarchy: [], containment: "approximate" }
		}

		// Approximate descent into finer tiers than the winner.
		let current = winner
		let currentConfirmed = winnerConfirmed
		let currentDistanceKm = currentConfirmed ? undefined : haversineKm(lat, lon, current.lat, current.lon)
		for (const tier of DESCENT_TIERS) {
			if (placetypeDepth(tier) <= placetypeDepth(current.placetype)) continue
			if (opts.placetypes && !opts.placetypes.includes(tier)) continue
			const kids = this.#descendants(current.id, tier, lat, lon, maxApproximateKm)
			let next: CandidateRow | null = null
			let nextConfirmed = false
			let nextKm: number | undefined
			let bestKm = Infinity
			for (const k of kids) {
				const contains = geometryContains(this.#geometry(k.id), lon, lat)
				if (contains === true) {
					next = k
					nextConfirmed = true
					nextKm = undefined
					break
				}
				if (contains === false) continue // known not-here — polygon rejected
				const km = haversineKm(lat, lon, k.lat, k.lon)
				if (km <= maxApproximateKm && km < bestKm) {
					bestKm = km
					next = k
					nextConfirmed = false
					nextKm = km
				}
			}
			if (next) {
				current = next
				currentConfirmed = nextConfirmed
				currentDistanceKm = nextKm
			}
			// An empty tier is NOT terminal — counties without localadmins jump straight to locality.
		}

		// Hierarchy assembly via the shared ancestor walk. If the descent crossed an ancestry gap
		// (the deepest place's recorded lineage misses the PIP root), merge the root's own chain so
		// region/country are always present when a polygon confirmed them.
		const byId = new Map<number, PlaceCandidate>()
		byId.set(current.id, toPlaceCandidate(current, currentDistanceKm))
		for (const a of ancestorLineage(this.#admin, current.id)) {
			if (!byId.has(a.id)) {
				byId.set(a.id, { ...a, placetype: a.placetype as WofPlacetype, country: a.country ?? "", score: 0 })
			}
		}
		if (!byId.has(winner.id)) {
			byId.set(winner.id, toPlaceCandidate(winner))
			for (const a of ancestorLineage(this.#admin, winner.id)) {
				if (!byId.has(a.id)) {
					byId.set(a.id, { ...a, placetype: a.placetype as WofPlacetype, country: a.country ?? "", score: 0 })
				}
			}
		}
		const hierarchy = [...byId.values()]
		if (opts.placetypes) {
			const allowed = new Set<string>(opts.placetypes)
			for (let i = hierarchy.length - 1; i >= 0; i--) {
				if (!allowed.has(hierarchy[i]!.placetype)) hierarchy.splice(i, 1)
			}
		}
		hierarchy.sort((a, b) => placetypeDepth(b.placetype) - placetypeDepth(a.placetype))

		return { hierarchy, containment: currentConfirmed ? "polygon" : "approximate" }
	}

	/** Bbox candidates containing the point, smallest-area-first, via the `place_bbox` R*Tree. */
	#bboxCandidates(lat: number, lon: number, opts: ReverseGeocodeOpts): CandidateRow[] {
		const where: string[] = [
			"bbox.min_lat <= ?",
			"bbox.max_lat >= ?",
			"bbox.min_lon <= ?",
			"bbox.max_lon >= ?",
			"spr.is_current != 0",
			"spr.is_deprecated = 0",
		]
		const params: Array<number | string> = [lat, lat, lon, lon]
		if (opts.placetypes && opts.placetypes.length > 0) {
			where.push(`spr.placetype IN (${opts.placetypes.map(() => "?").join(", ")})`)
			params.push(...opts.placetypes)
		}
		params.push(opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
		return this.#admin
			.prepare(
				`SELECT spr.id AS id, spr.name AS name, spr.placetype AS placetype, spr.country AS country,
					spr.parent_id AS parent_id, spr.latitude AS lat, spr.longitude AS lon
				FROM ${PLACE_BBOX_TABLE} bbox JOIN spr ON spr.id = bbox.id
				WHERE ${where.join(" AND ")}
				ORDER BY (bbox.max_lat - bbox.min_lat) * (bbox.max_lon - bbox.min_lon) ASC
				LIMIT ?`
			)
			.all(...params) as unknown as CandidateRow[]
	}

	/**
	 * Descendants of `parentId` at one placetype tier, pre-filtered to a centroid window around the
	 * query point (a generous 4× the approximate cap — polygon-holding children may legitimately have
	 * far centroids, e.g. a sprawling consolidated city; the precise cap is applied per-candidate in
	 * the caller, and only to centroid-fallback steps).
	 */
	#descendants(parentId: number, placetype: string, lat: number, lon: number, maxApproximateKm: number): CandidateRow[] {
		const windowDeg = (maxApproximateKm * 4) / 111
		return this.#admin
			.prepare(
				`SELECT s.id AS id, s.name AS name, s.placetype AS placetype, s.country AS country,
					s.parent_id AS parent_id, s.latitude AS lat, s.longitude AS lon
				FROM ancestors a JOIN spr s ON s.id = a.id
				WHERE a.ancestor_id = ? AND s.placetype = ? AND s.is_current != 0 AND s.is_deprecated = 0
					AND s.latitude BETWEEN ? AND ? AND s.longitude BETWEEN ? AND ?`
			)
			.all(parentId, placetype, lat - windowDeg, lat + windowDeg, lon - windowDeg, lon + windowDeg) as unknown as CandidateRow[]
	}

	/** Parsed GeoJSON geometry for a WOF id, or null when absent / unparseable / no polygon DB. */
	#geometry(id: number): GeojsonGeometry | null {
		if (!this.#polygons) return null
		const cached = this.#geometryCache.get(id)
		if (cached !== undefined) return cached
		if (this.#geometryCache.size >= WofReverseGeocoder.#GEOMETRY_CACHE_CAP) this.#geometryCache.clear()
		const row = this.#polygons.prepare(`SELECT geom FROM polygons WHERE id = ?`).get(id) as
			| { geom: string }
			| undefined
		let geometry: GeojsonGeometry | null = null
		if (row) {
			try {
				geometry = JSON.parse(row.geom) as GeojsonGeometry
			} catch {
				geometry = null // malformed row — treat as no-polygon rather than failing the query
			}
		}
		this.#geometryCache.set(id, geometry)
		return geometry
	}

	close(): void {
		if (this.#ownsAdmin) this.#admin.close()
		if (this.#ownsPolygons) this.#polygons?.close()
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
