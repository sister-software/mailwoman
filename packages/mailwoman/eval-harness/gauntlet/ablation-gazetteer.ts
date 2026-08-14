/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The {@linkcode AblationGazetteerProbe} implementation: the two databases the ablation layer's expectation model
 *   reads, and nothing else.
 *
 *   - `wof/admin-global-priority.db` — `spr` + `ancestors`. The LADDER comes from here: a resolved place id → its
 *       containment chain, with each ancestor's centroid and bbox. The walk is `ancestorLineage`'s (shared with the
 *       reverse geocoder, `resolver-wof-sqlite/ancestry.ts`), extended with the bbox columns this model needs; both
 *       probes are PK / `ancestors_by_id` lookups.
 *   - `wof/candidate.db` — the byte-range candidate gazetteer. The AMBIGUITY count comes from here, keyed by the SAME
 *       `normalizeLocalityForKey` the resolver probes with, so "how many places share this name" is asked of the exact
 *       table the pipeline resolves against rather than of a second, differently-normalized index.
 *
 *   Both are opened read-only and both are OPTIONAL: a machine without them gets `available: false` and the layer falls
 *   back to anchor-only grading, loudly. A silently ladder-less run would report every variant as ungraded and look
 *   identical to a run where nothing degraded.
 *
 *   The queries stay raw `.prepare()` (the resolver-reader convention, AGENTS.md): they are synchronous point probes on
 *   a read-only artifact, called once per rung and once per component per variant.
 */

import { existsSync } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { haversineKm } from "@mailwoman/spatial"

import {
	type AblationGazetteerProbe,
	type AblationPlace,
	COINCIDENT_PLACE_KM,
	containmentDepth,
} from "./ablation-expectation.ts"

interface SprRow {
	id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	min_latitude: number
	max_latitude: number
	min_longitude: number
	max_longitude: number
}

interface CandidateRow {
	spr_id: number
	name: string | null
	placetype_id: number
	country_id: number
	latitude: number | null
	longitude: number | null
	min_lat: number | null
	max_lat: number | null
	min_lon: number | null
	max_lon: number | null
	neg_rank: number
	population: number | null
}

/**
 * `spr`'s bbox columns are `NOT NULL DEFAULT 0`, so an unset extent reads as `min == max` — the meaning-of-zero trap
 * this model must not fall into. Fold that to `null` at the READER, once, so nothing downstream can mistake it for an
 * extent of zero.
 */
function bboxOf(
	minLat: number | null,
	maxLat: number | null,
	minLon: number | null,
	maxLon: number | null
): AblationPlace["bbox"] {
	if (minLat == null || maxLat == null || minLon == null || maxLon == null) return null

	if (minLat === maxLat && minLon === maxLon) return null

	return { minLat, maxLat, minLon, maxLon }
}

/**
 * Parse the resolver's `placeID` URI (`wof:85974801`) back to a WOF id. `null` for anything else — the scheme is
 * deliberately simple (`resolver/resolve.ts`), and a future non-WOF backend must not be silently read as one.
 */
export function wofIDFromPlaceID(placeID: string | undefined): number | null {
	if (!placeID) return null

	const match = /^wof:(\d+)$/.exec(placeID)

	return match ? Number(match[1]) : null
}

/**
 * Collapse a population-ordered candidate list to DISTINCT PLACES: anything within {@linkcode COINCIDENT_PLACE_KM} of
 * an already-kept, higher-ranked entry is the same physical place (WOF stores a big city as both a `locality` and a
 * `localadmin`, same population). Exported because it is the step that makes a namesake count mean "namesakes".
 */
export function collapseCoincident(places: readonly AblationPlace[]): AblationPlace[] {
	const kept: AblationPlace[] = []

	for (const p of places) {
		if (kept.some((k) => haversineKm(k.lat, k.lon, p.lat, p.lon) <= COINCIDENT_PLACE_KM)) continue

		kept.push(p)
	}

	return kept
}

/**
 * How many candidate rows one name probe reads before collapsing. The probe is a contiguous scan of one `name_key` on
 * the clustered B-tree, so the cost is bounded by the namesake cluster itself; the cap only guards the pathological
 * keys (`San José` carries 886 rows worldwide). Sized well above the corpus's worst (886) so no corpus name is
 * truncated — a truncated list would UNDERSTATE ambiguity, which is the direction that turns an abstain into a false
 * expectation.
 */
const NAME_PROBE_LIMIT = 2000

/**
 * The two-database probe. Construct once per run; `close()` releases both handles.
 */
export class AblationGazetteer implements AblationGazetteerProbe {
	readonly available: boolean
	/**
	 * Why the probe is unavailable, when it is — printed by the runner so a ladder-less map is attributable.
	 */
	readonly unavailableReason: string | null

	#ancestry: DatabaseSync | null = null
	#candidates: DatabaseSync | null = null
	#placeStatement: StatementSync | null = null
	#lineageStatement: StatementSync | null = null
	#namedStatement: StatementSync | null = null
	#placetypeByID = new Map<number, string>()
	#countryByID = new Map<number, string>()
	#placeCache = new Map<number, AblationPlace | null>()
	#lineageCache = new Map<number, AblationPlace[]>()
	#namedCache = new Map<string, AblationPlace[]>()
	#reverse: { reverseGeocodeSync(lat: number, lon: number): { hierarchy: Array<{ id: number }> } } | null = null

	/**
	 * Build the probe with its reverse geocoder attached.
	 *
	 * The dynamic import keeps this optional dependency off ordinary evaluation paths, and
	 * `@mailwoman/resolver-wof-sqlite`'s index is not something a `mailwoman --help` should pay for. The reverse geocoder
	 * SHARES this object's already-open admin handle (`adminDatabase`), so it opens nothing and `close()` stays the
	 * single owner. No polygon sidecar is passed: there is no global `wof-polygons.db`, so containment is the approximate
	 * (nearest-centroid descent) mode — good enough to name a chain, and the chain is all this model wants from it.
	 */
	static async create(opts: { ancestryPath?: string; candidatePath?: string } = {}): Promise<AblationGazetteer> {
		const gazetteer = new AblationGazetteer(opts)

		if (!gazetteer.available) return gazetteer

		const { WOFReverseGeocoder } = await import("@mailwoman/resolver-wof-sqlite")

		gazetteer.#reverse = new WOFReverseGeocoder({ adminDatabase: gazetteer.#ancestry! })

		return gazetteer
	}

	constructor(opts: { ancestryPath?: string; candidatePath?: string } = {}) {
		const ancestryPath = opts.ancestryPath ?? dataRootPath("wof", "admin-global-priority.db")
		const candidatePath = opts.candidatePath ?? dataRootPath("wof", "candidate.db")
		const missing = [ancestryPath, candidatePath].filter((p) => !existsSync(p))

		if (missing.length) {
			this.available = false
			this.unavailableReason = `missing ${missing.join(", ")}`

			return
		}

		this.#ancestry = new DatabaseSync(ancestryPath, { readOnly: true })
		this.#candidates = new DatabaseSync(candidatePath, { readOnly: true })

		this.#placeStatement = this.#ancestry.prepare(
			`SELECT id, name, placetype, country, latitude, longitude,
				min_latitude, max_latitude, min_longitude, max_longitude
			 FROM spr WHERE id = ?`
		)

		// The `ancestorLineage` walk (resolver-wof-sqlite/ancestry.ts) plus the bbox columns — same join, same
		// `ancestors_by_id` index; ordering is done in JS below, deepest first.
		this.#lineageStatement = this.#ancestry.prepare(
			`SELECT s.id AS id, a.ancestor_placetype AS placetype, s.name AS name, s.country AS country,
				s.latitude AS latitude, s.longitude AS longitude,
				s.min_latitude AS min_latitude, s.max_latitude AS max_latitude,
				s.min_longitude AS min_longitude, s.max_longitude AS max_longitude
			 FROM ancestors a JOIN spr s ON s.id = a.ancestor_id
			 WHERE a.id = ? AND a.ancestor_id != a.id`
		)

		this.#namedStatement = this.#candidates.prepare(
			`SELECT spr_id, name, placetype_id, country_id, latitude, longitude,
				min_lat, max_lat, min_lon, max_lon, neg_rank, population
			 FROM candidate WHERE name_key = ? ORDER BY neg_rank ASC LIMIT ${NAME_PROBE_LIMIT}`
		)

		for (const row of this.#candidates.prepare(`SELECT id, placetype FROM placetype_codes`).all() as Array<{
			id: number
			placetype: string
		}>) {
			this.#placetypeByID.set(row.id, row.placetype)
		}

		for (const row of this.#candidates.prepare(`SELECT id, code FROM country_codes`).all() as Array<{
			id: number
			code: string
		}>) {
			this.#countryByID.set(row.id, row.code)
		}

		this.available = true
		this.unavailableReason = null
	}

	place(id: number): AblationPlace | null {
		if (!this.#placeStatement) return null

		const cached = this.#placeCache.get(id)

		if (cached !== undefined) return cached

		const row = this.#placeStatement.get(id) as unknown as SprRow | undefined

		const place: AblationPlace | null = row
			? {
					id: row.id,
					name: row.name,
					placetype: row.placetype,
					country: row.country,
					lat: row.latitude,
					lon: row.longitude,
					bbox: bboxOf(row.min_latitude, row.max_latitude, row.min_longitude, row.max_longitude),
					// `spr` carries no population column; the ranking margin is only ever taken over
					// candidate-table rows, so a lineage place's rank is never read.
					negRank: 0,
					population: null,
				}
			: null

		this.#placeCache.set(id, place)

		return place
	}

	lineage(id: number): AblationPlace[] {
		if (!this.#lineageStatement) return []

		const cached = this.#lineageCache.get(id)

		if (cached) return cached

		const rows = this.#lineageStatement.all(id) as unknown as SprRow[]

		const places = rows
			.map(
				(row): AblationPlace => ({
					id: row.id,
					name: row.name,
					placetype: row.placetype,
					country: row.country,
					lat: row.latitude,
					lon: row.longitude,
					bbox: bboxOf(row.min_latitude, row.max_latitude, row.min_longitude, row.max_longitude),
					negRank: 0,
					population: null,
				})
			)
			// Nearest-first: the ladder walks OUTWARD from the resolved place, so the chain must be deepest first.
			.toSorted((a, b) => containmentDepth(b.placetype) - containmentDepth(a.placetype))

		this.#lineageCache.set(id, places)

		return places
	}

	containingChain(lat: number, lon: number): AblationPlace[] {
		if (!this.#reverse) return []

		// The reverse hierarchy is already deepest-first; re-read each id off `spr` so every rung carries the bbox
		// (the reverse candidate shape does not).
		return this.#reverse
			.reverseGeocodeSync(lat, lon)
			.hierarchy.map((h) => this.place(h.id))
			.filter((p): p is AblationPlace => p != null)
	}

	named(name: string, opts: { country?: string; placetypes?: readonly string[] } = {}): AblationPlace[] {
		if (!this.#namedStatement) return []

		const key = normalizeLocalityForKey(name)

		if (!key) return []

		const cacheKey = `${key}|${opts.country ?? ""}|${(opts.placetypes ?? []).join(",")}`

		const cached = this.#namedCache.get(cacheKey)

		if (cached) return cached

		const rows = this.#namedStatement.all(key) as unknown as CandidateRow[]
		const allowed = opts.placetypes ? new Set(opts.placetypes) : null
		const seen = new Set<number>()
		const places: AblationPlace[] = []

		for (const row of rows) {
			if (row.latitude == null || row.longitude == null) continue

			if (seen.has(row.spr_id)) continue

			const placetype = this.#placetypeByID.get(row.placetype_id) ?? ""

			if (allowed && !allowed.has(placetype)) continue

			const country = this.#countryByID.get(row.country_id) ?? ""

			if (opts.country && country !== opts.country) continue

			seen.add(row.spr_id)

			places.push({
				id: row.spr_id,
				name: row.name ?? "",
				placetype,
				country,
				lat: row.latitude,
				lon: row.longitude,
				bbox: bboxOf(row.min_lat, row.max_lat, row.min_lon, row.max_lon),
				negRank: row.neg_rank,
				population: row.population,
			})
		}

		const collapsed = collapseCoincident(places)

		this.#namedCache.set(cacheKey, collapsed)

		return collapsed
	}

	close(): void {
		this.#ancestry?.close()
		this.#candidates?.close()
		this.#ancestry = null
		this.#candidates = null
	}
}
