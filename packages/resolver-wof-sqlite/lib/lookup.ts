/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `WOFSQLitePlaceLookup` — the resolver implementation backed by `node:sqlite` plus a Kysely-typed query layer where the queries are non-trivial and raw SQL where they are not.
 */

import { expandPlacetypeFilter } from "@mailwoman/codex/placetype-map"
import type { Ancestor, CoincidentLocality } from "@mailwoman/core/resolver"
import { allRows } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"
import type { DatabaseClient, SQLInputValue } from "@mailwoman/sqlite/client"
import { SQLiteLookup } from "@mailwoman/sqlite/lookup"
import type { PathBuilderLike } from "path-ts"

import { ancestorLineage } from "#ancestry"
import { candidateFromSearchRow, rankCandidates } from "#candidate/scoring"
import { loadCoincidentLocalities } from "#coincident-roles"
import {
	ADDRESS_CONVENTION_TABLE,
	resolveConvention,
	SeedConventionSource,
	type Convention,
	type ConventionSource,
	type ResolvedConvention,
	type Strategy,
} from "#convention"
import {
	pickExtractForPlacetype,
	pickExtractsForPlacetype,
	resolveExtracts,
	type ResolvedExtract,
	type ExtractConfig,
} from "#extracts"
import {
	buildPlaceSearchFTS,
	PLACE_BBOX_TABLE,
	PLACE_POPULATION_TABLE,
	PLACE_SEARCH_TABLE,
	placeBboxExists,
	placePopulationExists,
	placeSearchFTSExists,
} from "#fts"
import { normalizePlacetypes, sanitizeFTSQuery } from "#fts/query"
import { cfNormalize, softNameScore } from "#name-score"
import { encyclopedicClauses } from "#place-importance-schema"
import type { WOFPostalCityAliasLookup } from "#postal/city/alias/lookup"
import { DEFAULT_WEIGHTS, populationScaleTerm, type RankingWeights } from "#ranking-weights"
import type { WOFDatabase } from "#schema"
import { fetchSearchRows, type RawSearchRow } from "#search-fetch"
import { SqliteConventionSource } from "#sqlite/convention-source"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "#types"

export interface WOFSQLitePlaceLookupOpts {
	/**
	 * Path to the WOF SQLite distribution on disk, mutually exclusive with `database`;
	 * an array opens the first entry as main and ATTACHes the rest.
	 */
	databasePath?: PathBuilderLike | ReadonlyArray<PathBuilderLike | ExtractConfig>
	/**
	 * Pre-opened connection, mutually exclusive with `databasePath`; multi-extract requires `databasePath`.
	 */
	database?: DatabaseClient<WOFDatabase>
	/**
	 * When true, build the FTS5 `place_search` virtual table on construction if
	 * it is missing, on the main extract only.
	 * Default false.
	 */
	buildFTS?: boolean
	/**
	 * Geographic Rule Engine convention source, either a ready `ConventionSource`
	 * or a `{ wofID: Convention }` seed map.
	 * Default empty resolves every query to `WORLD_DEFAULT`.
	 */
	conventions?: ConventionSource | Record<number, Convention>
	/**
	 * Opt-in postal-city alias reader.
	 *
	 * Absent, every alias code path is skipped and the resolver is byte-identical.
	 */
	postalCityAliases?: WOFPostalCityAliasLookup
}

/**
 * The placetypes `pickExtractsForPlacetype`'s substring rule can route by name,
 * a subset of the WOF placetypes.
 */
const KNOWN_ROUTED_PLACETYPES: ReadonlyArray<string> = [
	"postalcode",
	"locality",
	"region",
	"county",
	"country",
	"venue",
]

const POSTCODE_LOCALITY_TABLE = "postcode_locality"

/**
 * Tunables for the coordinate-first locality soft-score
 * `Score = pc·S_pc + name·S_name + pop·S_pop` (each S in [0,1]).
 */
const CF_PC_DECAY_KM = 8
/**
 * The chosen locality must be within this distance of the postcode's containing
 * locality or the `mismatch` flag fires.
 */
const CF_MISMATCH_KM = 50

export class WOFSQLitePlaceLookup extends SQLiteLookup<WOFDatabase> implements PlaceLookup {
	readonly #weights: RankingWeights
	/**
	 * Cached at construction.
	 *
	 * An extract is considered to have the bbox index only if its own R*Tree table exists.
	 */
	readonly #hasBboxIndex: Map<string, boolean>
	/**
	 * Per-extract probe for the `place_population` aux table.
	 *
	 * When false, the left join is omitted and the population boost is 0 for every row.
	 */
	readonly #hasPopulationIndex: Map<string, boolean>
	/**
	 * Per-extract select term and left join for the two-score split's `encyclopedic` value,
	 * probed and built once at construction.
	 */
	readonly #encyclopedicClauses: Map<string, { select: string; join: string }>
	/**
	 * Per-extract probe for the `postcode_locality` table, cached at construction
	 * and null when absent so the coord-first path no-ops.
	 */
	readonly #postcodeLocalityExtract: string | null
	/**
	 * Resolved extract list, always at least one entry with `main` first.
	 */
	readonly #extracts: ResolvedExtract[]
	/**
	 * Per-schema probed country sets for country-aware extract routing, non-main extracts only.
	 */
	readonly #extractCountries: Map<string, ReadonlySet<string>>
	/**
	 * `#conventionSource` supplies per-WOF-polygon profiles for the Geographic Rule Engine.
	 *
	 * `#strategies` maps primitive names to strategies.
	 * `#countryWOFIdCache` memoizes country-code to country-WOF-id lookups.
	 */
	readonly #conventionSource: ConventionSource
	readonly #strategies: Map<string, Strategy>
	readonly #countryWOFIdCache = new Map<string, number | null>()
	/**
	 * Strategy names already warned about, so an unknown name surfaces once.
	 */
	readonly #warnedUnknownStrategies = new Set<string>()
	/**
	 * Lazily-built `admin_id → coincident localities` map, null until first use.
	 */
	#coincidentRolesCache: Map<number, CoincidentLocality[]> | null = null
	/**
	 * Per-id memoized ancestor lineages, queried once per chain.
	 */
	readonly #ancestorsCache = new Map<number, Ancestor[]>()
	/**
	 * Opt-in postal-city alias reader, `null` unless supplied, so every alias path is skipped by default.
	 */
	readonly #postalCityAliases: WOFPostalCityAliasLookup | null

	constructor(opts: WOFSQLitePlaceLookupOpts, weights?: Partial<RankingWeights>) {
		if (opts.database && opts.databasePath) {
			throw new Error("WOFSQLitePlaceLookup: pass either `database` or `databasePath`, not both")
		}

		if (!opts.database && !opts.databasePath) {
			throw new Error("WOFSQLitePlaceLookup: one of `database` or `databasePath` is required")
		}

		const extracts: ResolvedExtract[] = opts.database
			? [{ path: ":memory:", schemaName: "main", placetypes: [] }]
			: resolveExtracts(opts.databasePath!)

		// Read-only by default: shipped extracts are sealed 0444 and Docker `:ro`
		// mounts forbid a write-mode open.
		// Only `buildFTS` opens writable.
		super(opts.database ? { database: opts.database } : { databasePath: extracts[0]!.path }, {
			readOnly: !opts.buildFTS,
		})

		this.#extracts = extracts

		// Schema names were validated by resolveExtracts, so interpolating them is safe.
		// SQLite attach accepts no parameter for a schema name.
		for (const s of extracts.slice(1)) {
			this.database.exec(`ATTACH DATABASE '${s.path.replaceAll("'", "''")}' AS ${s.schemaName}`)
		}

		this.database.exec("PRAGMA busy_timeout = 5000")

		if (opts.buildFTS) {
			this.#ensureFTS()
		} else {
			this.#assertFTSExists()
		}

		this.#weights = { ...DEFAULT_WEIGHTS, ...weights }

		this.#hasBboxIndex = new Map()
		this.#hasPopulationIndex = new Map()
		this.#encyclopedicClauses = new Map()

		for (const s of this.#extracts) {
			this.#hasBboxIndex.set(s.schemaName, this.#extractHasTable(s.schemaName, PLACE_BBOX_TABLE))
			this.#hasPopulationIndex.set(s.schemaName, this.#extractHasTable(s.schemaName, PLACE_POPULATION_TABLE))
			this.#encyclopedicClauses.set(s.schemaName, encyclopedicClauses(this.database, s.schemaName))
		}

		// An extract is guarded when its path identifies a routed placetype
		// or it contains `spr`, and must then contain `place_search`; testing only one of
		// those would let an empty file through or exempt a build input.
		for (const s of this.#extracts) {
			if (s.schemaName === "main") continue

			const routes = KNOWN_ROUTED_PLACETYPES.some(
				(pt) => s.schemaName === pt || s.schemaName.startsWith(`${pt}_`) || s.schemaName.endsWith(`_${pt}`)
			)

			const claimsPlaceExtract = this.#extractHasTable(s.schemaName, "spr")

			if (!routes && !claimsPlaceExtract) continue

			if (this.#extractHasTable(s.schemaName, PLACE_SEARCH_TABLE)) continue

			throw new Error(
				`WOFSQLitePlaceLookup: ${s.path} ` +
					(claimsPlaceExtract
						? `carries "spr" but no "${PLACE_SEARCH_TABLE}" table, so it cannot serve a lookup.`
						: `is named for a routed placetype but carries neither "spr" nor "${PLACE_SEARCH_TABLE}", so every ` +
							`query routed to it would die mid-SELECT. An empty or truncated file reads exactly like this.`) +
					` Build it with the FTS index, or leave it out — it is usable as a BUILD input either way.` +
					(routes
						? ""
						: ` Its schema name "${s.schemaName}" also matches no routed placetype (${KNOWN_ROUTED_PLACETYPES.join(", ")}), ` +
							`so it would never have been queried even with the table — check the filename's spelling.`)
			)
		}

		// Probe each non-main extract's country set once at construction so two postcode
		// extracts route by the query's country instead of first-match starving the second.
		this.#extractCountries = new Map()

		for (const sh of this.#extracts) {
			if (sh.schemaName === "main") continue

			try {
				const rows = this.database
					.prepare(`SELECT DISTINCT country FROM ${sh.schemaName}.spr WHERE country != ''`)
					.all() as Array<{ country: string }>

				this.#extractCountries.set(sh.schemaName, new Set(rows.map((r) => r.country)))
			} catch {
				// An extract without spr (or an attach oddity) just doesn't participate in country routing.
			}
		}

		this.#postcodeLocalityExtract =
			this.#extracts.find((s) => this.#extractHasTable(s.schemaName, POSTCODE_LOCALITY_TABLE))?.schemaName ?? null

		this.#postalCityAliases = opts.postalCityAliases ?? null

		// Precedence: explicit `opts.conventions` wins, else an attached build-from-source
		// convention asset, else empty so EU uses `WORLD_DEFAULT`.
		const conventionExtract =
			this.#extracts.find((s) => this.#extractHasTable(s.schemaName, ADDRESS_CONVENTION_TABLE))?.schemaName ?? null

		this.#conventionSource = opts.conventions
			? "get" in opts.conventions && typeof opts.conventions.get === "function"
				? opts.conventions
				: new SeedConventionSource(opts.conventions as Record<number, Convention>)
			: conventionExtract
				? new SqliteConventionSource(this.database, conventionExtract)
				: new SeedConventionSource()

		this.#strategies = new Map<string, Strategy>([
			["postcode_area_resolution", (q, c) => this.#postcodeAreaResolution(q, c)],
			["fallback_fuzzy_name_match", (q) => this.#fuzzyNameMatch(q)],
		])
	}

	#extractHasTable(schemaName: string, tableName: string): boolean {
		// Main uses the existing helpers.
		// Attached extracts need the schema-qualified `sqlite_master`.
		if (schemaName === "main") {
			if (tableName === PLACE_BBOX_TABLE) return placeBboxExists(this.database)

			if (tableName === PLACE_POPULATION_TABLE) return placePopulationExists(this.database)
		}

		const row = this.database
			.prepare(`SELECT name FROM ${schemaName}.sqlite_master WHERE type = 'table' AND name = ?`)
			.get(tableName) as { name: string } | undefined

		return Boolean(row)
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		// Run the effective convention's candidate strategies in order.
		// The first non-null result wins and unknown strategy names are skipped.
		const convention = this.#conventionFor(query)

		let outcome: PlaceCandidate[] = []

		for (const name of convention.candidateStrategies) {
			const strategy = this.#strategies.get(name)

			if (!strategy) {
				this.#warnUnknownStrategy(name)

				continue
			}

			const result = await strategy(query, convention)

			if (result !== null) {
				outcome = result

				break
			}
		}

		if (outcome.length) return outcome

		// On a postcode-typed NL-shape miss, retry with the whitespace-joined form then the 4-digit stem,
		// restricted to NL so the same shape elsewhere cannot coarsen to another system's code.
		if (
			query.country?.toUpperCase() === "NL" &&
			(normalizePlacetypes(query.placetype)?.includes("postalcode") ?? false) &&
			/^\d{4}\s?[A-Za-z]{2}$/.test(query.text.trim())
		) {
			const trimmed = query.text.trim()
			const joined = trimmed.replaceAll(/\s+/g, "")

			if (joined !== trimmed) {
				const full = await this.findPlace({ ...query, text: joined })

				if (full.length) return full
			}

			const stem = trimmed.slice(0, 4)

			if (stem !== trimmed) return this.findPlace({ ...query, text: stem })
		}

		return outcome
	}

	/**
	 * Dual-role localities coincident with an admin id, or `[]` when the relation table is absent.
	 */
	coincidentLocalitiesFor(adminID: number | string): CoincidentLocality[] {
		const id = typeof adminID === "number" ? adminID : Number(adminID)

		if (!Number.isFinite(id)) return []

		if (!this.#coincidentRolesCache) {
			this.#coincidentRolesCache = loadCoincidentLocalities(this.database)
		}

		return this.#coincidentRolesCache.get(id) ?? []
	}

	/**
	 * The ancestor lineage of a place, ordered nearest-first with self excluded,
	 * or `[]` when it has no recorded ancestry.
	 */
	ancestors(id: number | string): Ancestor[] {
		const pid = typeof id === "number" ? id : Number(id)

		if (!Number.isFinite(pid)) return []
		const cached = this.#ancestorsCache.get(pid)

		if (cached) return cached

		const lineage: Ancestor[] = ancestorLineage(this.database, pid).map((r) => ({
			id: r.id,
			placetype: r.placetype,
			name: r.name,
		}))

		this.#ancestorsCache.set(pid, lineage)

		return lineage
	}

	/**
	 * Warn once per unknown strategy name rather than throwing, so a convention built
	 * against a newer revision degrades instead of stopping resolution.
	 */
	#warnUnknownStrategy(name: string): void {
		if (this.#warnedUnknownStrategies.has(name)) return
		this.#warnedUnknownStrategies.add(name)

		console.warn(
			`WOFSQLitePlaceLookup: a convention names strategy "${name}", which this build does not register ` +
				`(known: ${[...this.#strategies.keys()].join(", ")}). Skipping it. If the convention asset was built ` +
				`against a newer code revision, rebuild the asset for this one.`
		)
	}

	/**
	 * The coordinate-first locality strategy, returning `null` when its postcode,
	 * table, or locality conditions are unmet.
	 */
	#postcodeAreaResolution(query: FindPlaceQuery, convention: ResolvedConvention): Promise<PlaceCandidate[] | null> {
		if (!(query.postcode && this.#postcodeLocalityExtract && this.#isLocalityQuery(query))) {
			return Promise.resolve(null)
		}

		return this.#findLocalityCoordFirst(query, this.#postcodeLocalityExtract, convention)
	}

	/**
	 * The BM25 FTS name-match fallback, always returning an array so it terminates the dispatch chain.
	 */
	async #fuzzyNameMatch(query: FindPlaceQuery, forceExtract?: ResolvedExtract): Promise<PlaceCandidate[]> {
		const limit = query.limit ?? 10

		// Expand the placetype filter through the shared equivalence table so a `locality`
		// query also reaches `borough` and `localadmin` rows.
		const placetypes = expandPlacetypeFilter(normalizePlacetypes(query.placetype)) as WOFPlacetype[] | null
		// Postcode-typed queries keep the fused name-law shape.
		// Everything else splits on intra-token punctuation so hyphenated names
		// reach the FTS as their real terms.
		const ftsQuery = sanitizeFTSQuery(query.text, { fuseTokens: placetypes?.includes("postalcode") ?? false })

		if (!ftsQuery) return []

		// Multi-extract routing uses placetype.
		// Queries without `placetype` go to main.
		// Mixed-placetype spread across extracts is unsupported.
		const firstPlacetype = placetypes?.[0]

		// A country-less query with proximity hints queries every matching extract
		// so cross-extract ambiguity is visible.
		// The bound requires hints and an absent country.
		// It also requires more than one matching extract.
		const hasBiasHints = !!query.near || (query.bias?.length ?? 0) > 0

		if (!forceExtract && hasBiasHints && !query.country) {
			const matching = pickExtractsForPlacetype(this.#extracts, firstPlacetype)

			if (matching.length > 1) {
				const pools: PlaceCandidate[][] = []

				for (const sh of matching) {
					pools.push(await this.#fuzzyNameMatch(query, sh))
				}

				const byID = new Map<PlaceCandidate["id"], PlaceCandidate>()

				for (const c of pools.flat()) {
					if (!byID.has(c.id)) {
						byID.set(c.id, c)
					}
				}

				const merged = [...byID.values()]

				merged.sort(
					(a, b) =>
						Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false) ||
						(b.prominence ?? 0) - (a.prominence ?? 0) ||
						b.score - a.score
				)

				return merged.slice(0, limit)
			}
		}

		const extract =
			forceExtract ??
			pickExtractForPlacetype(this.#extracts, firstPlacetype, {
				country: query.country,
				countriesBySchema: this.#extractCountries,
			})

		// Validated at construction, so bare interpolation is safe.
		const sch = extract.schemaName

		const rawRows = fetchSearchRows({
			db: this.database,
			schemaName: sch,
			query,
			placetypes,
			ftsQuery,
			limit,
			hasBboxIndex: this.#hasBboxIndex,
			hasPopulationIndex: this.#hasPopulationIndex,
			encyclopedicClauses: this.#encyclopedicClauses,
			weights: this.#weights,
		})

		const scoring = {
			query,
			placetypes,
			queryLen: query.text.length,
			weights: this.#weights,
		}

		const candidates = rawRows.map((row) => candidateFromSearchRow(row, scoring))

		rankCandidates(candidates, {
			db: this.database,
			schemaName: sch,
			query,
			weights: this.#weights,
		})

		return candidates.slice(0, limit)
	}

	#isLocalityQuery(query: FindPlaceQuery): boolean {
		const pts = normalizePlacetypes(query.placetype)

		return !pts || pts.includes("locality")
	}

	/**
	 * Resolve the effective convention for a query, keyed by the country's WOF polygon id.
	 */
	#conventionFor(query: FindPlaceQuery): ResolvedConvention {
		const chain: number[] = []

		if (query.country) {
			const cid = this.#countryWOFId(query.country)

			if (cid !== null) {
				chain.push(cid)
			}
		}

		return resolveConvention(this.#conventionSource, chain)
	}

	/**
	 * Country ISO code to its WOF polygon id, memoized including the not-found `null`.
	 */
	#countryWOFId(code: string): number | null {
		const cached = this.#countryWOFIdCache.get(code)

		if (cached !== undefined) return cached
		let id: number | null

		try {
			const row = this.database
				.prepare(`SELECT id FROM main.spr WHERE placetype = 'country' AND country = ? AND is_current != 0 LIMIT 1`)
				.get(code) as { id: number } | undefined

			id = row?.id ?? null
		} catch {
			id = null
		}

		this.#countryWOFIdCache.set(code, id)

		return id
	}

	/**
	 * Coordinate-first locality resolution: union the postcode's containing
	 * and nearby localities with the FTS name candidates and soft-score them,
	 * returning null when the postcode is not in the table.
	 */
	async #findLocalityCoordFirst(
		query: FindPlaceQuery,
		sch: string,
		convention: ResolvedConvention
	): Promise<PlaceCandidate[] | null> {
		const w = convention.scoringWeights
		const pc = query.postcode!.trim()
		const pcWhere = query.country ? "postcode = ? AND country = ?" : "postcode = ?"
		const pcParams: SQLInputValue[] = query.country ? [pc, query.country] : [pc]

		const pcRows = allRows<{ id: number; aliases: string | null; dist: number; containing: number }>(
			this.database.prepare(
				`SELECT locality_id AS id, aliases, distance_km AS dist, is_containing AS containing
				 FROM ${sch}.${POSTCODE_LOCALITY_TABLE} WHERE ${pcWhere}`
			),
			...pcParams
		)

		if (!pcRows.length) return null

		const limit = query.limit ?? 10
		// Name-match candidates via the normal FTS path with the postcode cleared, so this cannot recurse.
		const ftsCands = await this.findPlace({ ...query, postcode: undefined, limit: Math.max(limit, 10) })

		const pcInfo = new Map<number, { dist: number; containing: boolean; aliases: string[] }>()

		for (const r of pcRows) {
			pcInfo.set(r.id, { dist: r.dist, containing: r.containing === 1, aliases: r.aliases ? r.aliases.split("|") : [] })
		}

		// Observed postal-city aliases for this postcode keyed by geographic locality name,
		// empty when the reader is not supplied.
		const postalAliasByGeo = new Map<string, string[]>()

		if (this.#postalCityAliases) {
			for (const a of await this.#postalCityAliases.getDivergentAliases(pc)) {
				const key = cfNormalize(a.geoLocality)

				if (!key) continue
				const bag = postalAliasByGeo.get(key)

				if (bag) {
					bag.push(a.postalCity)
				} else {
					postalAliasByGeo.set(key, [a.postalCity])
				}
			}
		}

		const merged = new Map<number, PlaceCandidate>()

		for (const c of ftsCands) {
			merged.set(c.id as number, c)
		}

		const missing = [...pcInfo.keys()].filter((id) => !merged.has(id))

		for (const row of this.#fetchLocalitiesByID(missing)) {
			merged.set(row.id, row)
		}

		const scored: Array<PlaceCandidate & { exact: boolean }> = []

		for (const cand of merged.values()) {
			const info = pcInfo.get(cand.id as number)
			const sPc = info ? (info.containing ? 1 : Math.exp(-info.dist / CF_PC_DECAY_KM)) : 0
			// Fold postal-city aliases into the soft name match.
			// The map is empty unless the opt-in reader was supplied, so scoring is unchanged when off.
			const wofAliases = info?.aliases ?? []

			const aliases = postalAliasByGeo.size
				? [...wofAliases, ...(postalAliasByGeo.get(cfNormalize(cand.name)) ?? [])]
				: wofAliases

			const sName = softNameScore(query.text, cand.name, aliases)
			const sPop = populationScaleTerm(cand.population, this.#weights)
			scored.push({ ...cand, score: w.pc * sPc + w.name * sName + w.pop * sPop, exact: sName >= 1 })
		}

		// An exact name or alias match tiers above coordinate-only candidates,
		// with the soft score breaking ties within a tier.
		scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)

		// When the chosen locality is not the postcode's containing locality and sits far
		// from it, flag `mismatch` rather than overriding the name.
		const top = scored[0]

		if (top) {
			// Among the postcode's candidate localities that resolved, prefer the containing one, else the nearest.
			const anchorRow = pcRows
				.filter((r) => merged.has(r.id))
				// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
				.sort((a, b) => b.containing - a.containing || a.dist - b.dist)[0]

			const anchor = anchorRow ? merged.get(anchorRow.id) : undefined

			if (
				anchor &&
				(top.id as number) !== anchorRow!.id &&
				haversineKm(top.lat, top.lon, anchor.lat, anchor.lon) > CF_MISMATCH_KM
			) {
				top.mismatch = true
			}
		}

		return scored.slice(0, limit).map(({ exact, ...c }) => {
			void exact

			return c
		})
	}

	/**
	 * Fetch locality spr rows from main for the postcode-injected candidate ids the FTS set missed.
	 */
	#fetchLocalitiesByID(ids: number[]): PlaceCandidate[] {
		if (!ids.length) return []
		const hasPop = this.#hasPopulationIndex.get("main") === true
		const popSelect = hasPop ? `pp.population AS population` : `NULL AS population`
		const popJoin = hasPop ? `LEFT JOIN main.${PLACE_POPULATION_TABLE} pp ON pp.id = s.id` : ""
		const ph = ids.map(() => "?").join(", ")

		const rows = allRows<RawSearchRow>(
			this.database.prepare(
				`SELECT s.id AS id, s.name AS name, s.country AS country, s.parent_id AS parent_id,
				        s.latitude AS lat, s.longitude AS lon, s.placetype AS placetype, ${popSelect}
				 FROM main.spr s ${popJoin}
				 WHERE s.id IN (${ph}) AND s.is_current != 0`
			),
			...ids
		)

		return rows.map((row) => {
			const c: PlaceCandidate = {
				id: row.id,
				name: row.name,
				placetype: row.placetype as WOFPlacetype,
				country: row.country ?? "",
				lat: row.lat ?? 0,
				lon: row.lon ?? 0,
				parent_id: row.parent_id ?? undefined,
				score: 0,
			}

			if (row.population !== null && row.population > 0) {
				c.population = row.population
			}

			return c
		})
	}

	/**
	 * Build the FTS5 virtual table from the `names` and `places` tables.
	 */
	#ensureFTS(): void {
		buildPlaceSearchFTS(this.database)
	}

	#assertFTSExists(): void {
		if (!placeSearchFTSExists(this.database)) {
			throw new Error(
				"WOFSQLitePlaceLookup: `place_search` FTS5 table is missing. Pass `buildFTS: true` to build it on open, or run `mailwoman gazetteer build fts <path-to-wof.db>` ahead of time (see resolver-wof-sqlite/README.md)."
			)
		}
	}
}

export type { RankingWeights } from "#ranking-weights"
