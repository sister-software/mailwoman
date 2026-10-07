/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import { type Ancestor, type GazetteerArtifactCoverage, referentialFromPopulation } from "@mailwoman/core/resolver"
import { allRows } from "@mailwoman/core/utils"
import { jaroWinkler, levenshteinSimilarity } from "@mailwoman/match/comparators"
import { partitionByContainment } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"

import {
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	intervalContains,
	type CandidateAncestorTable,
	type IntervalLabel,
} from "#candidate/ancestors/schema"
import { CANDIDATE_FTS_TABLE } from "#candidate/fts"
import type { CandidateDatabase, CandidateTable, CountryCodeTable, PlacetypeCodeTable } from "#candidate/schema"
import { readGazetteerCoverageManifest } from "#coverage-manifest-schema"
import { POSTAL_CITY_CANDIDATE_TABLE, type PostalCityCandidateTable } from "#postal/city/candidate-schema"
import { rankByPrimaryPreference, type RankedRow, RERANK_FETCH } from "#primary-preference"
import { applyProximityRerank } from "#proximity-rerank"
import { REGION_CLASS_PLACETYPES, regionQualifierProbeKeys } from "#region-keys"
import { hasColumn, hasTable } from "#sqlite-utils"
import { type NameKey, normalizeLocalityForKey, stripLocalityQualifier } from "#street/normalize"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "#types"

export { rankByPrimaryPreference } from "#primary-preference"
export type { RankedRow } from "#primary-preference"

/**
 * Where a {@link WOFCandidateTableLookup} reads from
 * (a read-only `candidate.db` or a caller-held connection) and how it ranks.
 */
export interface WOFCandidateTableLookupOpts extends SQLiteLookupOptions<CandidateDatabase> {
	/**
	 * Exempt `name_role = 'variant'` aliases from the cross-country primary-preference penalty.
	 * No-ops without the role column and is off by default.
	 */
	variantAliasExemption?: boolean
}

type CandidateRow = Pick<
	CandidateTable,
	| "spr_id"
	| "name"
	| "country_id"
	| "placetype_id"
	| "latitude"
	| "longitude"
	| "min_lat"
	| "min_lon"
	| "max_lat"
	| "max_lon"
	| "neg_rank"
	| "is_primary"
	| "population"
> &
	// Optional because older artifacts may not include `importance`.
	Partial<Pick<CandidateTable, "importance">>

const FUZZY_FETCH = 40

const WORD_FUZZY_MIN = 0.85

function wordFuzzySimilarity(a: string, b: string): number {
	return Math.max(jaroWinkler(a, b), levenshteinSimilarity(a, b))
}

const POSTCODE_CONTAINMENT_THRESHOLD_KM = 25

function ftsTrigramQuery(s: string): string {
	const grams = new Set<string>()

	for (let i = 0; i + 3 <= s.length; i++) {
		const g = s.slice(i, i + 3)

		if (/^[\p{L}\p{N} ]{3}$/u.test(g)) {
			grams.add(g)
		}
	}

	return [...grams].map((g) => `"${g}"`).join(" OR ")
}

/**
 * Node {@link PlaceLookup} over `candidate.db`.
 */
export class WOFCandidateTableLookup extends SQLiteLookup<CandidateDatabase> implements PlaceLookup {
	readonly #countryToID = new Map<string, number>()
	readonly #idToCountry = new Map<number, string>()
	readonly #placetypeToID = new Map<string, number>()
	readonly #idToPlacetype = new Map<number, string>()

	readonly #postalCityProbe: ReturnType<DatabaseClient["prepare"]> | undefined

	readonly #ftsProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	/**
	 * Prepared unfiltered `name_key` existence probe, so fuzzy fallback runs only for true name misses.
	 */
	readonly #nameKeyExistsProbe: ReturnType<DatabaseClient["prepare"]> | undefined

	readonly artifactCoverage: GazetteerArtifactCoverage | null

	readonly #importanceSelect: string

	readonly #hasNameRole: boolean
	readonly #variantAliasExemption: boolean

	readonly #roleSelect: string

	readonly #ancestorsProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	readonly #ancestorsCache = new Map<number, Ancestor[]>()

	readonly #intervalProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	readonly #intervalCache = new Map<number, IntervalLabel | null>()

	readonly #qualifierProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	/**
	 * Ancestor lineage accessor, nearest-first, present only when the artifact supports it.
	 */
	readonly ancestors: ((id: number | string) => Ancestor[]) | undefined

	constructor(opts: WOFCandidateTableLookupOpts) {
		super(opts)

		for (const r of allRows<CountryCodeTable>(this.database.prepare("SELECT id, code FROM country_codes"))) {
			const code = String(r.code).toUpperCase()
			this.#countryToID.set(code, Number(r.id))
			this.#idToCountry.set(Number(r.id), code)
		}

		for (const r of allRows<PlacetypeCodeTable>(this.database.prepare("SELECT id, placetype FROM placetype_codes"))) {
			this.#placetypeToID.set(String(r.placetype), Number(r.id))
			this.#idToPlacetype.set(Number(r.id), String(r.placetype))
		}

		if (hasTable(this.database, POSTAL_CITY_CANDIDATE_TABLE)) {
			this.#postalCityProbe = this.database.prepare(
				`SELECT spr_id, name, latitude, longitude FROM ${POSTAL_CITY_CANDIDATE_TABLE} WHERE name_key = ? AND postcode = ? LIMIT 1`
			)
		}

		if (hasTable(this.database, CANDIDATE_FTS_TABLE)) {
			this.#ftsProbe = this.database.prepare(
				`SELECT name_key FROM ${CANDIDATE_FTS_TABLE} WHERE ${CANDIDATE_FTS_TABLE} MATCH ? ORDER BY bm25(${CANDIDATE_FTS_TABLE}) LIMIT ?`
			)

			this.#nameKeyExistsProbe = this.database.prepare("SELECT 1 FROM candidate WHERE name_key = ? LIMIT 1")
		}

		// Optional columns are detected once here for hot-path reads.
		this.#importanceSelect = hasColumn(this.database, "candidate", "importance") ? ", importance" : ""
		this.#hasNameRole = hasColumn(this.database, "candidate", "name_role")
		this.#variantAliasExemption = opts.variantAliasExemption === true
		this.#roleSelect = this.#hasNameRole ? ", name_role" : ""

		if (hasTable(this.database, CANDIDATE_ANCESTOR_TABLE)) {
			this.#ancestorsProbe = this.database.prepare(
				`SELECT parent_spr_id, parent_placetype_id, parent_name FROM ${CANDIDATE_ANCESTOR_TABLE}` +
					" WHERE spr_id = ? ORDER BY depth ASC"
			)

			this.ancestors = (id) => this.#ancestorLineage(id)
		}

		if (this.#ancestorsProbe && hasTable(this.database, CANDIDATE_INTERVAL_TABLE)) {
			this.#intervalProbe = this.database.prepare(`SELECT pre, post FROM ${CANDIDATE_INTERVAL_TABLE} WHERE spr_id = ?`)

			const bandIDs = [...REGION_CLASS_PLACETYPES, "country"]
				.map((placetype) => this.#placetypeToID.get(placetype))
				.filter((id): id is number => id !== undefined)

			if (bandIDs.length) {
				this.#qualifierProbe = this.database.prepare(
					`SELECT DISTINCT spr_id FROM candidate WHERE name_key = ? AND placetype_id IN (${bandIDs.join(",")}) LIMIT 8`
				)
			}
		}

		this.artifactCoverage = readGazetteerCoverageManifest(this.database)
	}

	#ancestorLineage(id: number | string): Ancestor[] {
		const pid = typeof id === "number" ? id : Number(id)

		if (!Number.isFinite(pid) || !this.#ancestorsProbe) return []

		const cached = this.#ancestorsCache.get(pid)

		if (cached) return cached

		const rows = allRows<Pick<CandidateAncestorTable, "parent_spr_id" | "parent_placetype_id" | "parent_name">>(
			this.#ancestorsProbe,
			pid
		)

		const lineage: Ancestor[] = rows.map((r) => ({
			id: Number(r.parent_spr_id),
			placetype: this.#idToPlacetype.get(Number(r.parent_placetype_id)) ?? "",
			name: String(r.parent_name ?? ""),
		}))

		this.#ancestorsCache.set(pid, lineage)

		return lineage
	}

	#intervalLabel(sprID: number): IntervalLabel | null {
		if (!this.#intervalProbe) return null

		const cached = this.#intervalCache.get(sprID)

		if (cached !== undefined) return cached

		const row = this.#intervalProbe.get(sprID) as { pre: number; post: number } | undefined
		const label = row ? { pre: Number(row.pre), post: Number(row.post) } : null

		this.#intervalCache.set(sprID, label)

		return label
	}

	#qualifierRegionIDs(qualifier: string, country: string | null): Set<number> {
		const ids = new Set<number>()

		if (!this.#qualifierProbe) return ids

		for (const key of regionQualifierProbeKeys(qualifier, country)) {
			if (!key) continue

			for (const row of allRows<{ spr_id: number }>(this.#qualifierProbe, key)) {
				ids.add(Number(row.spr_id))
			}
		}

		return ids
	}

	/**
	 * Whether `sprID` is contained by any qualifier row, using interval labels first
	 * and the ancestor chain as fallback.
	 */
	#containedByQualifier(sprID: number, qualifierIDs: ReadonlySet<number>, qualifierLabels: IntervalLabel[]): boolean {
		if (qualifierIDs.has(sprID)) return true

		const label = this.#intervalLabel(sprID)

		if (label && qualifierLabels.some((outer) => intervalContains(outer, label))) return true

		return this.#ancestorLineage(sprID).some((ancestor) => qualifierIDs.has(Number(ancestor.id)))
	}

	/**
	 * Apply admin-containment re-rank: stamp containment, inject contained misses,
	 * then partition contained-first.
	 */
	#applyAdminContainment(
		rows: Array<RankedRow<CandidateRow>>,
		qualifier: string,
		country: string | null,
		opts: {
			nameKey: NameKey
			strippedKey: NameKey
			shapeFilters: string[]
			shapeParams: Array<string | number>
			limit: number
		}
	): Array<RankedRow<CandidateRow>> {
		const qualifierIDs = this.#qualifierRegionIDs(qualifier, country)

		if (!qualifierIDs.size) {
			for (const row of rows) {
				row.containedByQualifier = false
			}

			return rows
		}

		const qualifierLabels = [...qualifierIDs]
			.map((id) => this.#intervalLabel(id))
			.filter((label): label is IntervalLabel => label !== null)

		const contained = (sprID: number): boolean => this.#containedByQualifier(sprID, qualifierIDs, qualifierLabels)

		for (const row of rows) {
			row.containedByQualifier = contained(Number(row.spr_id))
		}

		const present = new Set(rows.map((row) => Number(row.spr_id)))
		const injected: Array<RankedRow<CandidateRow>> = []

		const injectSQL = (primaryOnly: boolean): string =>
			"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank, is_primary, population" +
			`${this.#importanceSelect} FROM candidate WHERE ${["name_key = ?", ...opts.shapeFilters, ...(primaryOnly ? ["is_primary = 1"] : [])].join(" AND ")} ` +
			"ORDER BY neg_rank ASC LIMIT ?"

		const injectFrom = (key: string, primaryOnly: boolean): void => {
			const fetched = allRows<CandidateRow>(
				this.database.prepare(injectSQL(primaryOnly)),
				key,
				...opts.shapeParams,
				RERANK_FETCH
			)

			for (const row of fetched) {
				const sprID = Number(row.spr_id)

				if (present.has(sprID) || !contained(sprID)) continue
				present.add(sprID)

				injected.push({ ...row, effectiveNegRank: row.neg_rank, demoted: false, containedByQualifier: true })
			}
		}

		injectFrom(opts.nameKey, false)

		// Also inject contained neighborhood-band namesakes (primary-keyed only).
		const bandIDs = ["neighbourhood", "macrohood", "microhood"]
			.map((placetype) => this.#placetypeToID.get(placetype))
			.filter((id): id is number => id !== undefined)

		if (bandIDs.length) {
			const bandSQL =
				"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank, is_primary, population" +
				`${this.#importanceSelect} FROM candidate WHERE name_key = ? AND placetype_id IN (${bandIDs.map(() => "?").join(",")}) AND is_primary = 1 ` +
				"ORDER BY neg_rank ASC LIMIT ?"

			const fetched = allRows<CandidateRow>(this.database.prepare(bandSQL), opts.nameKey, ...bandIDs, RERANK_FETCH)

			for (const row of fetched) {
				const sprID = Number(row.spr_id)

				if (present.has(sprID) || !contained(sprID)) continue
				present.add(sprID)

				injected.push({ ...row, effectiveNegRank: row.neg_rank, demoted: false, containedByQualifier: true })
			}
		}

		// Try stripped-key injection only when exact-key containment found no row.
		if (
			!injected.length &&
			!rows.some((row) => row.containedByQualifier) &&
			opts.strippedKey &&
			opts.strippedKey !== opts.nameKey
		) {
			injectFrom(opts.strippedKey, true)
		}

		if (!injected.length && !rows.some((row) => row.containedByQualifier)) return rows

		return partitionByContainment(
			[...rows, ...injected],
			(row) => row.containedByQualifier === true,
			(row) => !row.demoted && !row.fuzzy
		).slice(0, opts.limit)
	}

	#wantsLocality(placetype: FindPlaceQuery["placetype"]): boolean {
		if (!placetype) return true
		const want = Array.isArray(placetype) ? placetype : [placetype]

		return expandPlacetypeFilter(want as readonly string[]).includes("locality")
	}

	#postcodeAnchor(postcode: string, country?: string): { lat: number; lon: number } | null {
		const placetypeID = this.#placetypeToID.get("postalcode")

		if (placetypeID === undefined) return null

		const conds = ["name_key = ?", "placetype_id = ?"]
		const params: Array<string | number> = [postcode.replaceAll(/\s+/g, ""), placetypeID]

		if (country) {
			const countryID = this.#countryToID.get(country.toUpperCase())

			if (countryID === undefined) return null // Unknown country in this artifact.
			conds.push("country_id = ?")
			params.push(countryID)
		}

		const row = this.database
			.prepare(`SELECT latitude, longitude FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT 1`)
			.get(...params) as { latitude: number; longitude: number } | undefined

		if (!row || (Number(row.latitude) === 0 && Number(row.longitude) === 0)) return null

		return { lat: Number(row.latitude), lon: Number(row.longitude) }
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		let text = (query.text ?? "").trim()

		if (!text) return []

		// Postcode queries use whitespace-stripped keying.
		const wantsPostcode = [query.placetype].flat().includes("postalcode")

		if (wantsPostcode) {
			text = text.replaceAll(/\s+/g, "")
		}

		const nameKey = normalizeLocalityForKey(text)

		if (!nameKey) return []

		if (query.postcode && this.#postalCityProbe && this.#wantsLocality(query.placetype)) {
			const hit = this.#postalCityProbe.get(nameKey, query.postcode.trim()) as
				| Pick<PostalCityCandidateTable, "spr_id" | "name" | "latitude" | "longitude">
				| undefined

			if (hit) {
				return [
					{
						id: Number(hit.spr_id),
						name: String(hit.name ?? ""),
						placetype: "locality" as WOFPlacetype,
						country: query.country?.toUpperCase() ?? "",
						lat: Number(hit.latitude),
						lon: Number(hit.longitude),
						parent_id: null,
						score: 1,
						distanceKm: null,
						exactMatch: true,
						prominence: null,
						population: null,
						referential: null,
						encyclopedic: null,
						importance: null,
						bbox: null,
						mismatch: null,
						containedByQualifier: null,
						regionScopeMiss: null,
						variantAliasExempted: null,
					},
				]
			}
		}

		const limit = Math.max(1, query.limit ?? 10)

		// Shape filters are tracked separately from the shared country scope for exact and stripped probes.
		const filters: string[] = []
		const filterParams: Array<string | number> = []
		const shapeFilters: string[] = []
		const shapeParams: Array<string | number> = []

		if (query.country) {
			const cid = this.#countryToID.get(query.country.toUpperCase())

			if (cid === undefined) return [] // Unknown country in this artifact.
			filters.push("country_id = ?")
			filterParams.push(cid)
		}

		if (query.placetype) {
			// Expand placetype equivalents (e.g. locality includes borough/localadmin).
			const want = Array.isArray(query.placetype) ? query.placetype : [query.placetype]

			const ids = expandPlacetypeFilter(want as readonly string[])
				.map((t) => this.#placetypeToID.get(t))
				.filter((v): v is number => v !== undefined)

			if (!ids.length) return []
			shapeFilters.push(`placetype_id IN (${ids.map(() => "?").join(",")})`)
			shapeParams.push(...ids)
		}

		if (query.bbox) {
			const b = query.bbox
			shapeFilters.push("latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?")
			shapeParams.push(b.minLat, b.maxLat, b.minLon, b.maxLon)
		}

		// Optional guard: restrict to primary rows for token-extracted probes.
		if (query.primaryOnly) {
			shapeFilters.push("is_primary = 1")
		}

		// The role filter is skipped on an artifact lacking `name_role`.
		if (query.excludeNameRoles?.length && this.#hasNameRole) {
			shapeFilters.push(`(name_role IS NULL OR name_role NOT IN (${query.excludeNameRoles.map(() => "?").join(",")}))`)
			shapeParams.push(...query.excludeNameRoles)
		}

		filters.push(...shapeFilters)
		filterParams.push(...shapeParams)

		// Region scope is optional (`region_id = parentID`); the fallback stays unscoped.
		const regionParentID = query.parentID || null

		const probe = (nk: string, regionID: number | null, countryID?: number): Array<RankedRow<CandidateRow>> => {
			const conds = ["name_key = ?", ...filters]
			const params: Array<string | number> = [nk, ...filterParams]

			if (regionID !== null) {
				conds.push("region_id = ?")
				params.push(regionID)
			}

			if (typeof countryID === "number") {
				conds.push("country_id = ?")
				params.push(countryID)
			}

			// Population-ordered fetch over-fetches for the bounded primary-preference rerank.
			const sql =
				"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank, is_primary, population" +
				`${this.#importanceSelect}${this.#roleSelect} FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT ?`

			const fetched = allRows<CandidateRow>(this.database.prepare(sql), ...params, Math.max(limit, RERANK_FETCH))

			return rankByPrimaryPreference(fetched, limit, undefined, this.#idToPlacetype, this.#variantAliasExemption)
		}

		const cascade = (regionID: number | null): Array<RankedRow<CandidateRow>> => {
			let rows = probe(nameKey, regionID)

			if (!rows.length) {
				const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(text))

				if (strippedKey && strippedKey !== nameKey) {
					// Stripped probes only accept primary rows to avoid alias-scrape matches.
					rows = probe(strippedKey, regionID).filter((r) => r.is_primary === 1)
				}
			}

			// Typo-tolerant fallback for true name misses only, skipping postcodes and respecting the fuzzy-country scope.
			const fuzzyCountryID =
				!query.country && query.fuzzyCountry ? this.#countryToID.get(query.fuzzyCountry.toUpperCase()) : undefined

			const fuzzyScopedOut = !query.country && !!query.fuzzyCountry && typeof fuzzyCountryID !== "number"

			if (
				!rows.length &&
				!wantsPostcode &&
				!fuzzyScopedOut &&
				this.#ftsProbe &&
				this.#nameKeyExistsProbe &&
				!this.#nameKeyExistsProbe.get(nameKey)
			) {
				const match = ftsTrigramQuery(nameKey)

				if (match) {
					const hits = allRows<{ name_key: string }>(this.#ftsProbe, match, FUZZY_FETCH)

					const ranked = hits
						.map((h) => ({ nk: String(h.name_key), s: wordFuzzySimilarity(nameKey, String(h.name_key)) }))
						.filter((h) => h.s >= WORD_FUZZY_MIN)
						// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
						.sort((a, b) => b.s - a.s)

					const seen = new Set<string>()

					for (const h of ranked) {
						if (seen.has(h.nk)) continue
						seen.add(h.nk)

						rows.push(...probe(h.nk, regionID, fuzzyCountryID).map((r) => ({ ...r, fuzzy: true })))

						if (rows.length >= limit) break
					}

					rows = rows.slice(0, limit)
				}
			}

			return rows
		}

		let rows = cascade(regionParentID)

		let regionScopeMiss = false

		if (!rows.length && regionParentID !== null) {
			rows = cascade(null)
			regionScopeMiss = rows.length > 0
		}

		if (
			query.postcode &&
			query.postcodeContainmentCoherence === true &&
			this.#wantsLocality(query.placetype) &&
			rows.length > 1
		) {
			const anchor = this.#postcodeAnchor(query.postcode, query.country)

			if (anchor) {
				const insideThreshold: Array<{ row: RankedRow<CandidateRow>; distanceKm: number }> = []
				const outsideThreshold: RankedRow<CandidateRow>[] = []

				for (const row of rows) {
					const distanceKm = haversineKm(anchor.lat, anchor.lon, Number(row.latitude), Number(row.longitude))

					if (distanceKm <= POSTCODE_CONTAINMENT_THRESHOLD_KM) {
						insideThreshold.push({ row, distanceKm })
					} else {
						outsideThreshold.push(row)
					}
				}

				if (insideThreshold.length) {
					// oxlint-disable-next-line unicorn/no-array-sort -- hot-path in-place sort
					insideThreshold.sort((a, b) => a.distanceKm - b.distanceKm)
					rows = [...insideThreshold.map(({ row }) => row), ...outsideThreshold]
				}
			}
		}

		// Admin-containment re-rank runs last.
		if (query.regionQualifier?.trim() && this.#qualifierProbe && this.#wantsLocality(query.placetype)) {
			rows = this.#applyAdminContainment(rows, query.regionQualifier.trim(), query.country ?? null, {
				nameKey,
				strippedKey: normalizeLocalityForKey(stripLocalityQualifier(text)),
				shapeFilters,
				shapeParams,
				limit,
			})
		}

		const candidates = rows.map((row): PlaceCandidate => {
			const hasBbox = row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null
			const parent = this.#ancestorLineage(Number(row.spr_id))[0]
			const hasPopulation = row.population !== null && row.population > 0

			return {
				id: Number(row.spr_id),
				name: String(row.name ?? ""),
				placetype: (this.#idToPlacetype.get(Number(row.placetype_id)) ?? "") as WOFPlacetype,

				country: this.#idToCountry.get(Number(row.country_id)) ?? "",
				lat: Number(row.latitude),
				lon: Number(row.longitude),

				parent_id: parent ? Number(parent.id) : null,

				score: -Number(row.neg_rank),
				distanceKm: null,

				prominence: -Number(row.effectiveNegRank),

				exactMatch: !row.demoted && !row.fuzzy,

				regionScopeMiss: regionScopeMiss ? true : null,

				containedByQualifier: row.containedByQualifier ?? null,

				variantAliasExempted: row.variantExempted ? true : null,

				population: hasPopulation ? row.population : null,
				referential: hasPopulation ? referentialFromPopulation(row.population) : null,
				encyclopedic: null,

				importance: typeof row.importance === "number" && Number.isFinite(row.importance) ? row.importance : null,
				bbox: hasBbox
					? {
							minLat: Number(row.min_lat),
							maxLat: Number(row.max_lat),
							minLon: Number(row.min_lon),
							maxLon: Number(row.max_lon),
						}
					: null,
				mismatch: null,
			}
		})

		if (query.bias && query.bias.length) {
			applyProximityRerank(candidates, query.bias)
		}

		return candidates
	}
}
