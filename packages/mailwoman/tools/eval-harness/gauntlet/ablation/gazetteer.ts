/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The {@linkcode AblationGazetteerProbe} implementation: only wof/admin-global-priority.db and wof/candidate.db are read, both optional, so a machine without them gets `available: false` and anchor-only grading.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { allRows, getRow } from "@mailwoman/core/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { StatementSync } from "@mailwoman/sqlite/client"
import { resolvePath, type PathBuilderLike } from "path-ts"

import {
	type AblationGazetteerProbe,
	type AblationPlace,
	collapseCoincident,
	containmentDepth,
} from "#ablation/expectation"

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
 * `spr`'s bbox columns are `not NULL default 0`, so an unset extent reads as `min == max`
 * and is folded to `null` at the reader once.
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
 * Parses the resolver's `placeID` URI back to a WOF id, returning `null` for anything else
 * so a future non-WOF backend is not silently read as one.
 */
export function wofIDFromPlaceID(placeID: string | null): number | null {
	if (!placeID) return null

	const match = /^wof:(\d+)$/.exec(placeID)

	return match ? Number(match[1]) : null
}

/**
 * How many candidate rows one name probe reads before collapsing, sized at 2000 well above the corpus's
 * worst key (886 rows for `San José`) so no corpus name is truncated and ambiguity is not understated.
 */
const NAME_PROBE_LIMIT = 2000

/**
 * A two-database probe constructed once per run.
 * Disposal releases both handles.
 */
export class AblationGazetteer implements AblationGazetteerProbe {
	readonly available: boolean
	/**
	 * Why the probe is unavailable, when it is — printed by the runner so a ladder-less map is attributable.
	 */
	readonly unavailableReason: string | null

	#ancestry: DatabaseClient<WOFDatabase> | null = null
	#candidates: DatabaseClient<WOFDatabase> | null = null
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
	 * Builds the probe with its reverse geocoder attached, keeping the dynamic import off
	 * ordinary evaluation paths and sharing the already-open admin handle.
	 */
	static async create(
		opts: { ancestryPath?: PathBuilderLike; candidatePath?: PathBuilderLike } = {}
	): Promise<AblationGazetteer> {
		const ancestryPath = opts.ancestryPath ?? wofDatabasePath("admin-global-priority.db")
		const candidatePath = opts.candidatePath ?? wofDatabasePath("candidate.db")
		const missing: string[] = []

		if (!(await pathExists(ancestryPath))) {
			missing.push(resolvePath(ancestryPath))
		}

		if (!(await pathExists(candidatePath))) {
			missing.push(resolvePath(candidatePath))
		}

		const gazetteer = new AblationGazetteer({ ancestryPath, candidatePath, missingPaths: missing })

		if (!gazetteer.available) return gazetteer

		const { WOFReverseGeocoder } = await import("@mailwoman/resolver-wof-sqlite")

		gazetteer.#reverse = new WOFReverseGeocoder({ adminDatabase: gazetteer.#ancestry! })

		return gazetteer
	}

	/**
	 * Constructs the probe from the caller's existence check, opening no handle
	 * while any path appears in `missingPaths`.
	 */
	constructor(
		opts: { ancestryPath?: PathBuilderLike; candidatePath?: PathBuilderLike; missingPaths?: readonly string[] } = {}
	) {
		const ancestryPath = opts.ancestryPath ?? wofDatabasePath("admin-global-priority.db")
		const candidatePath = opts.candidatePath ?? wofDatabasePath("candidate.db")
		const missing = opts.missingPaths ?? []

		if (missing.length) {
			this.available = false
			this.unavailableReason = `missing ${missing.join(", ")}`

			return
		}

		this.#ancestry = new DatabaseClient<WOFDatabase>(ancestryPath, { readOnly: true })
		this.#candidates = new DatabaseClient<WOFDatabase>(candidatePath, { readOnly: true })

		this.#placeStatement = this.#ancestry.prepare(
			`SELECT id, name, placetype, country, latitude, longitude,
				min_latitude, max_latitude, min_longitude, max_longitude
			 FROM spr WHERE id = ?`
		)

		// The `ancestorLineage` walk plus the bbox columns, same join and `ancestors_by_id`
		// index, ordered deepest first in JS below.
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

		const row = getRow<SprRow>(this.#placeStatement, id)

		const place: AblationPlace | null = row
			? {
					id: row.id,
					name: row.name,
					placetype: row.placetype,
					country: row.country,
					lat: row.latitude,
					lon: row.longitude,
					bbox: bboxOf(row.min_latitude, row.max_latitude, row.min_longitude, row.max_longitude),
					// `spr` has no population column.
					// The margin uses candidate-table rows, so it never reads a lineage place's rank.
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

		const rows = allRows<SprRow>(this.#lineageStatement, id)

		const places = rows
			.map((row): AblationPlace => ({
				id: row.id,
				name: row.name,
				placetype: row.placetype,
				country: row.country,
				lat: row.latitude,
				lon: row.longitude,
				bbox: bboxOf(row.min_latitude, row.max_latitude, row.min_longitude, row.max_longitude),
				negRank: 0,
				population: null,
			}))
			// Nearest-first: the ladder walks outward from the resolved place, so the chain must be deepest first.
			.toSorted((a, b) => containmentDepth(b.placetype) - containmentDepth(a.placetype))

		this.#lineageCache.set(id, places)

		return places
	}

	containingChain(lat: number, lon: number): AblationPlace[] {
		if (!this.#reverse) return []

		// The reverse hierarchy is already deepest-first.
		// Each id is re-read off `spr` so every rung includes the bbox the reverse candidate shape lacks.
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

		const rows = allRows<CandidateRow>(this.#namedStatement, key)
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

	[Symbol.dispose](): void {
		this.#ancestry?.destroy()
		this.#candidates?.destroy()
		this.#ancestry = null
		this.#candidates = null
	}
}
