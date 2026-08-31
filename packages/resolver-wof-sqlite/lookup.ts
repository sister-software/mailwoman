/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `WOFSQLitePlaceLookup` — the resolver implementation backed by `node:sqlite` + a Kysely-typed
 *   query layer where the queries are non-trivial, and raw SQL where they aren't (FTS5 MATCH, the
 *   FTS index build).
 *
 *   See `docs/plan/phases/PHASE_4_2_wof_sqlite.md` for the design rationale.
 */

import { expandPlacetypeFilter, type Ancestor, type CoincidentLocality } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import type { SQLInputValue } from "@mailwoman/sqlite/client"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { ancestorLineage } from "#ancestry"
import { candidateFromSearchRow, rankCandidates } from "#candidate-scoring"
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
	buildPlaceSearchFTS,
	PLACE_BBOX_TABLE,
	PLACE_POPULATION_TABLE,
	PLACE_SEARCH_TABLE,
	placeBboxExists,
	placePopulationExists,
	placeSearchFTSExists,
} from "#fts"
import { normalizePlacetypes, sanitizeFTSQuery } from "#fts-query"
import { cfNormalize, softNameScore } from "#name-score"
import { encyclopedicClauses } from "#place-importance-schema"
import type { WOFPostalCityAliasLookup } from "#postal-city-alias-lookup"
import { DEFAULT_WEIGHTS, type RankingWeights } from "#ranking-weights"
import type { WOFDatabase } from "#schema"
import { fetchSearchRows, type RawSearchRow } from "#search-fetch"
import {
	pickShardForPlacetype,
	pickShardsForPlacetype,
	resolveShards,
	type ResolvedShard,
	type ShardConfig,
} from "#sharding"
import { SqliteConventionSource } from "#sqlite-convention-source"
import { allRows } from "#sqlite-utils"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "#types"

export interface WOFSQLitePlaceLookupOpts {
	/**
	 * Path to the WOF SQLite distribution on disk. Mutually exclusive with `database`.
	 *
	 * **Single string** — opens that one DB as the main shard.
	 *
	 * **Array** — opens the first entry as main, then ATTACHes each subsequent entry as a separate SQLite schema. Schema
	 * names are derived from the filename (`whosonfirst-data-postalcode- us-latest.db` → `postalcode_us`); override with
	 * `ShardConfig.schemaName` when the filename doesn't follow WOF convention. See `sharding.ts` for the derivation
	 * rules.
	 *
	 * Routing: queries with a `placetype` matching a shard's name (or explicit `placetypes` hint) are sent to that shard;
	 * everything else hits main. Cross-shard UNION is NOT done — BM25 isn't comparable across separately-indexed
	 * corpora.
	 */
	databasePath?: string | ReadonlyArray<string | ShardConfig>
	/**
	 * Pre-opened connection — primarily for tests against an inline fixture DB. Mutually exclusive with `databasePath`.
	 * Multi-shard requires `databasePath` (so the lookup owns the ATTACH).
	 */
	database?: DatabaseClient<WOFDatabase>
	/**
	 * If true, build the FTS5 `place_search` virtual table on construction if it doesn't already exist. The upstream WOF
	 * distribution does NOT ship FTS5, so callers either set this once on first open or pre-build it via the
	 * operator-side CLI documented in the README. Default false — the resolver assumes the index already exists and
	 * errors loudly if it doesn't.
	 *
	 * With multi-shard, `buildFTS: true` builds the index on the **main** shard only. Other shards must be pre-built via
	 * `mailwoman gazetteer build fts` — operator script for predictable cost.
	 */
	buildFTS?: boolean
	/**
	 * Geographic Rule Engine convention source (Direction E, #289). Per-WOF-polygon resolution profiles, either as a
	 * ready `ConventionSource` or a plain `{ wofID: Convention }` seed map. Default empty — every query rides
	 * `WORLD_DEFAULT` (the EU coordinate-first behavior). JP/KR/TW add rows; #290 wires a build-from-source sqlite-backed
	 * source here.
	 */
	conventions?: ConventionSource | Record<number, Convention>
	/**
	 * Opt-in postal-city alias reader (#475). When supplied, the coordinate-first locality scorer treats an observed
	 * `postal_city` ("Antioch", postcode 37013) as a name-match alias for the geographic locality the postcode sits in
	 * ("Nashville"), recovering the chronic postal-vs- geographic-city mismatch. Absent (the default), the resolver is
	 * byte-identical — every alias code path is gated on this being non-null, so an unprovided reader changes no score.
	 */
	postalCityAliases?: WOFPostalCityAliasLookup
}

/**
 * The coordinate-first candidate table (scripts/build-postcode-locality.ts): postcode → containing
 *
 * - Nearby localities with WOF alt-name aliases.
 */
/**
 * The placetypes `pickShardsForPlacetype`'s substring rule can route by name. Not every WOF placetype — only the ones a
 * purpose-built shard is ever named for — so the diagnostic below can say "this name routes nowhere" without claiming
 * to enumerate the gazetteer.
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
 * Tunables for the coordinate-first locality soft-score `Score = pc·S_pc + name·S_name + pop·S_pop` (each S in [0,1]).
 * The pc/name/pop WEIGHTS now come from the resolved convention's `scoringWeights` (`WORLD_DEFAULT` = 0.6/0.3/0.1 — the
 * EU values), so a locale can retune them as data. PC_DECAY_KM sets how fast S_pc falls with distance.
 */
const CF_PC_DECAY_KM = 8
/**
 * The chosen locality must be within this distance of the postcode's containing locality, else the postcode and the
 * parsed city name are judged to disagree (a transposed / wrong-for-the-city postcode) and the `mismatch` flag fires.
 * Generous enough that a city-state Ortsteil (~15km from the city centroid) and an abutting town (~few km) are NOT
 * flagged, tight enough to catch a wrong city (hundreds of km).
 */
const CF_MISMATCH_KM = 50

export class WOFSQLitePlaceLookup implements PlaceLookup, Disposable {
	readonly #db: DatabaseClient<WOFDatabase>
	/**
	 * Resources this instance opened. A connection handed in by a caller is NOT in here, so disposal cannot reach it —
	 * ownership is membership rather than a flag a later branch has to check.
	 */
	readonly #resources = new DisposableStack()
	readonly #weights: RankingWeights
	/**
	 * Cached at construction so we don't `sqlite_master` query on every findPlace call. Bbox + near- with-radius queries
	 * fall back to no-filter when this is false, preserving compatibility with DBs that were FTS-built before the R*Tree
	 * shipped.
	 *
	 * Per-shard: a shard is only considered to have the bbox index if its own R*Tree table exists.
	 */
	readonly #hasBboxIndex: Map<string, boolean>
	/**
	 * Per-shard probe for the `place_population` aux table. When false, the LEFT JOIN is omitted from the SELECT and
	 * population boost is 0 for every row — preserves compatibility with DBs built before this feature shipped.
	 */
	readonly #hasPopulationIndex: Map<string, boolean>
	/**
	 * Per-shard SELECT term + LEFT JOIN for the two-score split's `encyclopedic` carry (ROAD_TO_V9 §2 R1), probed and
	 * built once at construction. Degrades to `NULL AS encyclopedic` with no join on a pre-split shard — every shipped
	 * shard today. See {@link encyclopedicClauses} for why the probe is a column and not a table.
	 */
	readonly #encyclopedicClauses: Map<string, { select: string; join: string }>
	/**
	 * Per-shard probe for the `postcode_locality` table (the coordinate-first candidate table, built by
	 * scripts/build-postcode-locality.ts). Cached at construction; null'd out when absent so the coord-first path
	 * silently no-ops on a deployment that didn't ship the table.
	 */
	readonly #postcodeLocalityShard: string | null
	/**
	 * Resolved shard list. Always at least one entry; first is `main`. Multi-shard adds extras with their own derived (or
	 * override) schema names.
	 */
	readonly #shards: ResolvedShard[]
	/**
	 * #920: per-schema probed country sets for country-aware shard routing (non-main shards only).
	 */
	readonly #shardCountries: Map<string, ReadonlySet<string>>
	/**
	 * The Geographic Rule Engine (Direction E, #289). `#conventionSource` supplies per-WOF-polygon resolution profiles;
	 * `#strategies` is the named-primitive registry the merged convention dispatches. Empty source → every query resolves
	 * to `WORLD_DEFAULT` → byte-identical to the pre-engine coordinate-first path. `#countryWOFIdCache` memoizes the
	 * country-code → country-WOF-id lookup that seeds the convention ancestor chain (one query per country, then
	 * cached).
	 */
	readonly #conventionSource: ConventionSource
	readonly #strategies: Map<string, Strategy>
	readonly #countryWOFIdCache = new Map<string, number | null>()
	/**
	 * Strategy names already warned about — so an unknown name surfaces once, not once per query.
	 */
	readonly #warnedUnknownStrategies = new Set<string>()
	/**
	 * Lazily-built `admin_id → coincident localities` map from the #403 relation (null until first use).
	 */
	#coincidentRolesCache: Map<number, CoincidentLocality[]> | null = null
	/**
	 * Per-id memoized ancestor lineages (#404) — a hot chain is queried once.
	 */
	readonly #ancestorsCache = new Map<number, Ancestor[]>()
	/**
	 * Opt-in postal-city alias reader (#475). `null` unless `opts.postalCityAliases` was supplied — every alias code path
	 * is gated on this, so the default resolver is byte-identical.
	 */
	readonly #postalCityAliases: WOFPostalCityAliasLookup | null

	constructor(opts: WOFSQLitePlaceLookupOpts, weights?: Partial<RankingWeights>) {
		if (opts.database && opts.databasePath) {
			throw new Error("WOFSQLitePlaceLookup: pass either `database` or `databasePath`, not both")
		}

		if (!opts.database && !opts.databasePath) {
			throw new Error("WOFSQLitePlaceLookup: one of `database` or `databasePath` is required")
		}

		if (opts.database) {
			this.#db = opts.database
			this.#shards = [{ path: ":memory:", schemaName: "main", placetypes: [] }]
		} else {
			const shards = resolveShards(opts.databasePath!)
			this.#shards = shards
			// Read-only by default — shipped gazetteer shards are sealed 0444 and Docker `:ro` mounts
			// forbid write-mode opens, so a writable open fails there. The only code path that writes to
			// the main shard is `#ensureFTS()` (FTS5 index build), gated on `opts.buildFTS`; open writable
			// ONLY when that build was explicitly requested. Every read query (FTS5 MATCH, the aux-table
			// SELECTs, ATTACH, and the `busy_timeout` PRAGMA) works read-only. See the docker read-only
			// mount limitation (#1213).
			this.#db = this.#resources.use(new DatabaseClient<WOFDatabase>(shards[0]!.path, { readOnly: !opts.buildFTS }))

			// ATTACH each non-main shard. Schema names were validated by resolveShards, so safe to
			// interpolate directly (SQLite ATTACH doesn't accept parameters for the schema name).
			for (const s of shards.slice(1)) {
				this.#db.exec(`ATTACH DATABASE '${s.path.replaceAll("'", "''")}' AS ${s.schemaName}`)
			}
		}

		// node:sqlite has no .pragma() helper; pragmas are executed as plain SQL.
		this.#db.exec("PRAGMA busy_timeout = 5000")

		if (opts.buildFTS) {
			this.#ensureFTS()
		} else {
			this.#assertFTSExists()
		}

		this.#weights = { ...DEFAULT_WEIGHTS, ...weights }

		// Probe each shard's aux-table presence — driven by per-shard table existence in
		// sqlite_master. Cached at construction so findPlace doesn't query sqlite_master per call.
		this.#hasBboxIndex = new Map()
		this.#hasPopulationIndex = new Map()
		this.#encyclopedicClauses = new Map()

		for (const s of this.#shards) {
			this.#hasBboxIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_BBOX_TABLE))
			this.#hasPopulationIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_POPULATION_TABLE))
			this.#encyclopedicClauses.set(s.schemaName, encyclopedicClauses(this.#db, s.schemaName))
		}

		// Every lookup path here reaches `place_search`, and a shard without it fails in one of two ways
		// that are both hard to read: an unroutable name returns zero hits (indistinguishable from "this
		// country has no places") and a routable one throws mid-query from deep inside a SELECT. The
		// unroutable half is the worse of the two — a shard reaches routing only through the name
		// `deriveSchemaName` derives from its FILENAME, so a file spelled one letter off the placetype it
		// serves answers with nothing while holding every row that was asked for.
		//
		// Two independent things bring a shard under the guard, and it needs both. Carrying `spr` is a
		// CLAIM to be a place shard. Carrying a name that routes is an INVITATION to be queried as one, and
		// it is made by the filename alone — so a database with no tables at all still gets picked, still
		// answers no query, and still dies inside a SELECT. Testing only the claim lets an empty or
		// truncated file past construction; testing only the name would exempt a correctly-named build
		// input. A shard needs to fail neither test to be exempt.
		//
		// Exempt by design: `postcode-locality-<cc>.db` carries a relation table and nothing else, matches
		// no routed placetype, and is part of the documented default shard list.
		for (const s of this.#shards) {
			if (s.schemaName === "main") continue

			const routes = KNOWN_ROUTED_PLACETYPES.some(
				(pt) => s.schemaName === pt || s.schemaName.startsWith(`${pt}_`) || s.schemaName.endsWith(`_${pt}`)
			)

			const claimsPlaceShard = this.#shardHasTable(s.schemaName, "spr")

			if (!routes && !claimsPlaceShard) continue

			if (this.#shardHasTable(s.schemaName, PLACE_SEARCH_TABLE)) continue

			throw new Error(
				`WOFSQLitePlaceLookup: ${s.path} ` +
					(claimsPlaceShard
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

		// #920 country-aware shard routing: probe each NON-MAIN shard's country set once at
		// construction (they're small, purpose-built shards — postcode/locality slices; main is the
		// multi-GB admin DB and is the fallback anyway, so it is deliberately NOT scanned). Feeds
		// pickShardForPlacetype so two postcode shards (postalcode-us + postalcode-geonames-tail)
		// route by the query's country instead of first-match starving the second shard.
		this.#shardCountries = new Map()

		for (const sh of this.#shards) {
			if (sh.schemaName === "main") continue

			try {
				const rows = this.#db
					.prepare(`SELECT DISTINCT country FROM ${sh.schemaName}.spr WHERE country != ''`)
					.all() as Array<{ country: string }>

				this.#shardCountries.set(sh.schemaName, new Set(rows.map((r) => r.country)))
			} catch {
				// A shard without spr (or an attach oddity) just doesn't participate in country routing.
			}
		}

		// The postcode_locality table can live on any attached shard (typically its own
		// `postcode-locality-<cc>.db`). Find the first shard that has it; null = coord-first disabled.
		this.#postcodeLocalityShard =
			this.#shards.find((s) => this.#shardHasTable(s.schemaName, POSTCODE_LOCALITY_TABLE))?.schemaName ?? null

		// Opt-in postal-city alias reader (#475). Construction-time present-or-not is the gate: null
		// keeps the coordinate-first scorer byte-identical to pre-#475.
		this.#postalCityAliases = opts.postalCityAliases ?? null

		// The Geographic Rule Engine convention source. Precedence: an explicit `opts.conventions`
		// (a ready source or a seed map) wins; else the build-from-source convention asset if one is
		// attached (auto-detected, like the postcode_locality shard — adding conventions.db to
		// databasePath enables it; queried on demand, not paged into memory); else empty, so EU rides
		// WORLD_DEFAULT. The registry binds strategy NAMES to the SQL-bound primitives — adding a
		// strategy is registering it here.
		const conventionShard =
			this.#shards.find((s) => this.#shardHasTable(s.schemaName, ADDRESS_CONVENTION_TABLE))?.schemaName ?? null

		this.#conventionSource = opts.conventions
			? "get" in opts.conventions && typeof opts.conventions.get === "function"
				? opts.conventions
				: new SeedConventionSource(opts.conventions as Record<number, Convention>)
			: conventionShard
				? new SqliteConventionSource(this.#db, conventionShard)
				: new SeedConventionSource()

		this.#strategies = new Map<string, Strategy>([
			["postcode_area_resolution", (q, c) => this.#postcodeAreaResolution(q, c)],
			["fallback_fuzzy_name_match", (q) => this.#fuzzyNameMatch(q)],
		])
	}

	#shardHasTable(schemaName: string, tableName: string): boolean {
		// For main, the existing helpers work directly. For attached shards we have to ask via the
		// schema-qualified `sqlite_master` view.
		if (schemaName === "main") {
			if (tableName === PLACE_BBOX_TABLE) return placeBboxExists(this.#db)

			if (tableName === PLACE_POPULATION_TABLE) return placePopulationExists(this.#db)
		}

		const row = this.#db
			.prepare(`SELECT name FROM ${schemaName}.sqlite_master WHERE type = 'table' AND name = ?`)
			.get(tableName) as { name: string } | undefined

		return Boolean(row)
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		// Geographic Rule Engine dispatch (#289). Resolve the effective convention for this query
		// (WORLD_DEFAULT for the EU locales — the seed source is empty) and run its candidate strategies
		// in order; the first to return a non-null result wins. The default list,
		// [postcode_area_resolution, fallback_fuzzy_name_match], reproduces the pre-engine coordinate-
		// first → FTS fall-through exactly. Unknown strategy names are skipped, so a convention may name
		// a primitive a future phase will register.
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

		// #924: NL postcode retry ladder. The WOF NL postalcode repo stores full codes UNSPACED
		// ('1012LG') plus 4-digit stems ('1012'), while Dutch addresses carry the spaced form
		// ('1012 LG') — two FTS tokens that can never match the one-token doc (the #920 name law,
		// resurfacing in a WOF-built shard). On a postcode-typed NL-shape miss, retry ONCE with the
		// whitespace-joined form (block-level precision when the full-code row exists), then the
		// 4-digit stem (area-level). Country-gated to NL — the same digits+letters shape elsewhere
		// must not silently coarsen to a different system's code. Each retry only fires when its
		// text differs from the current one, so the ladder terminates by construction.
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
	 * Dual-role localities coincident with an admin id, from the precomputed `coincident_roles` relation (#403). Backs
	 * {@link ResolveOpts.hierarchyCompletion} (#405): O(1) once the relation is loaded. Returns `[]` when the relation
	 * table is absent (older DB) or the admin isn't a dual-role place, so completion degrades gracefully. The relation +
	 * `spr` join is loaded once and memoized.
	 */
	coincidentLocalitiesFor(adminID: number | string): CoincidentLocality[] {
		const id = typeof adminID === "number" ? adminID : Number(adminID)

		if (!Number.isFinite(id)) return []

		if (!this.#coincidentRolesCache) {
			this.#coincidentRolesCache = loadCoincidentLocalities(this.#db)
		}

		return this.#coincidentRolesCache.get(id) ?? []
	}

	/**
	 * The ancestor lineage of a place — its containment chain joined with `spr` for canonical names, ordered
	 * NEAREST-FIRST (localadmin → county → region → … → country). Backs {@link ResolveOpts.includeAncestors} (#404). Self
	 * is excluded; memoized per id. Returns `[]` when the place has no recorded ancestry.
	 *
	 * The walk itself lives in `ancestry.ts` (shared with the reverse geocoder, #484); the ordering is its
	 * `PLACETYPE_DEPTH` table — same ranking as the previous inline SQL CASE, extended below `localadmin` so
	 * locality/neighbourhood ancestors order correctly instead of sorting last.
	 */
	ancestors(id: number | string): Ancestor[] {
		const pid = typeof id === "number" ? id : Number(id)

		if (!Number.isFinite(pid)) return []
		const cached = this.#ancestorsCache.get(pid)

		if (cached) return cached

		const lineage: Ancestor[] = ancestorLineage(this.#db, pid).map((r) => ({
			id: r.id,
			placetype: r.placetype,
			name: r.name,
		}))

		this.#ancestorsCache.set(pid, lineage)

		return lineage
	}

	/**
	 * Surface an unknown strategy name LOUDLY (once per name) rather than swallowing it silently — an invisible no-op is
	 * exactly the hidden-dependency failure mode we avoid (see the provenance-first design value). We warn rather than
	 * throw so a convention asset built against a newer code revision (one that adds a strategy) degrades gracefully on
	 * an older build instead of taking down resolution.
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
	 * Strategy `postcode_area_resolution` — the coordinate-first locality path, strictly gated (a sibling postcode AND a
	 * postcode_locality table AND a locality query). Returns `null` — so the dispatcher falls through to the next
	 * strategy — when the gate is unmet or the postcode isn't in the table; otherwise the soft-scored postcode∪name
	 * candidate set.
	 */
	#postcodeAreaResolution(query: FindPlaceQuery, convention: ResolvedConvention): Promise<PlaceCandidate[] | null> {
		if (!(query.postcode && this.#postcodeLocalityShard && this.#isLocalityQuery(query))) {
			return Promise.resolve(null)
		}

		return this.#findLocalityCoordFirst(query, this.#postcodeLocalityShard, convention)
	}

	/**
	 * Strategy `fallback_fuzzy_name_match` — the BM25 FTS name-match over the gazetteer, the universal fallback. Always
	 * returns an array (never null), so it terminates the dispatch chain.
	 */
	async #fuzzyNameMatch(query: FindPlaceQuery, forceShard?: ResolvedShard): Promise<PlaceCandidate[]> {
		const limit = query.limit ?? 10

		// Expand the placetype filter through the shared equivalence table (core/resolver): a
		// `locality` query must also reach `borough` / `localadmin` rows — Brooklyn-the-borough
		// (pop 2.5M) is a borough, not a locality, and a strict filter made it unreachable so the
		// fuzzy "Brooklyn Park, MN" won instead. Order-preserving: the FIRST entry stays the
		// requested placetype, which is what shard routing keys off below.
		const placetypes = expandPlacetypeFilter(normalizePlacetypes(query.placetype)) as WOFPlacetype[] | null
		// Postcode-typed queries keep the #920 fused name-law shape; everything else splits on
		// intra-token punctuation so hyphenated names reach the FTS as their real terms (#945).
		const ftsQuery = sanitizeFTSQuery(query.text, { fuseTokens: placetypes?.includes("postalcode") ?? false })

		if (!ftsQuery) return []

		// Pick the shard for this query. Multi-shard routing is placetype-driven; a query without
		// `placetype` always goes to main. (Mixed-placetype queries with multiple shards aren't
		// supported in v1 — caller can issue two findPlace calls and merge in TS if needed.)
		const firstPlacetype = placetypes?.[0]

		// Bias fan-out (#58/proximity-bias): a country-less query WITH proximity hints must see the
		// cross-shard ambiguity the hints exist to resolve — "48026" lives in postalcode-us AND
		// postalcode-intl, and single-shard routing would hide one side. Query every matching shard
		// (self-recursion with a shard pin), merge by id, and re-sort by the same (exact, prominence)
		// keys the per-shard tier sort used. Bounded: hints + no country + >1 matching shard only.
		const hasBiasHints = !!query.near || (query.bias?.length ?? 0) > 0

		if (!forceShard && hasBiasHints && !query.country) {
			const matching = pickShardsForPlacetype(this.#shards, firstPlacetype)

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

		const shard =
			forceShard ??
			pickShardForPlacetype(this.#shards, firstPlacetype, {
				country: query.country,
				countriesBySchema: this.#shardCountries,
			})

		// bare schema name; safe to interpolate (validated at construction)
		const sch = shard.schemaName

		const rawRows = fetchSearchRows({
			db: this.#db,
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
			db: this.#db,
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
	 * Resolve the effective convention for a query (the Geographic Rule Engine entry point). The ancestor chain is keyed
	 * by WOF polygon id; for #289 it carries just the country level — resolved from `query.country` via the cached
	 * code→WOF-id lookup — so the EU locales, which have no override rows, resolve to `WORLD_DEFAULT` and dispatch is
	 * byte-identical to the pre-engine path. E4 (JP) extends the chain with the resolved locality's `ancestors` row, so a
	 * region/locality-level convention (e.g. Sapporo's grid) deep-merges over the country one.
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
	 * Country ISO code → its WOF polygon id (the coarsest convention key). Cached — one indexed `spr` query per distinct
	 * country, then memoized (including a not-found `null`) so findPlace never pays for it twice.
	 */
	#countryWOFId(code: string): number | null {
		const cached = this.#countryWOFIdCache.get(code)

		if (cached !== undefined) return cached
		let id: number | null

		try {
			const row = this.#db
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
	 * Coordinate-first locality resolution. The postcode_locality table maps the sibling postcode to the locality whose
	 * polygon contains the postcode centroid (+ a few nearby ones for the abutting- postcode case). We union those
	 * COORDINATE candidates with the FTS NAME candidates and soft-score the union `0.6·S_pc + 0.3·S_name + 0.1·S_pop` —
	 * so a small town the name-match never finds is recovered by the postcode, while an unambiguous name (Berlin) still
	 * wins on name + population. Returns null when the postcode isn't in the table (→ caller falls back to the FTS
	 * path).
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
			this.#db.prepare(
				`SELECT locality_id AS id, aliases, distance_km AS dist, is_containing AS containing
				 FROM ${sch}.${POSTCODE_LOCALITY_TABLE} WHERE ${pcWhere}`
			),
			...pcParams
		)

		if (!pcRows.length) return null

		const limit = query.limit ?? 10
		// Name-match candidates via the normal FTS path (postcode cleared → no recursion).
		const ftsCands = await this.findPlace({ ...query, postcode: undefined, limit: Math.max(limit, 10) })

		const pcInfo = new Map<number, { dist: number; containing: boolean; aliases: string[] }>()

		for (const r of pcRows) {
			pcInfo.set(r.id, { dist: r.dist, containing: r.containing === 1, aliases: r.aliases ? r.aliases.split("|") : [] })
		}

		// #475 (opt-in): observed postal-city aliases for this postcode, keyed by the geographic
		// locality name they map to. A user-typed postal city ("Antioch", 37013) becomes a name-match
		// alias for the geographic locality the postcode sits in ("Nashville"). Empty when the reader
		// isn't supplied → the scoring loop below is byte-identical to pre-#475.
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
			// Fold any postal-city aliases for this candidate's geographic name into the soft name match
			// (#475). `postalAliasByGeo` is empty unless the opt-in reader was supplied, so when off this
			// reduces to the original `info?.aliases ?? []` and the score is unchanged.
			const wofAliases = info?.aliases ?? []

			const aliases = postalAliasByGeo.size
				? [...wofAliases, ...(postalAliasByGeo.get(cfNormalize(cand.name)) ?? [])]
				: wofAliases

			const sName = softNameScore(query.text, cand.name, aliases)
			const sPop = cand.population && cand.population > 0 ? Math.min(1, Math.log10(1 + cand.population) / 6) : 0
			scored.push({ ...cand, score: w.pc * sPc + w.name * sName + w.pop * sPop, exact: sName >= 1 })
		}

		// Exact-name tiering (same philosophy as the FTS path): an EXACT name/alias match tiers above
		// coordinate-only candidates, with the soft-score breaking ties WITHIN a tier. This keeps an
		// unambiguous city ("Berlin", exact + huge population) ahead of the fine-grained Ortsteil its
		// postcode centroid lands in, while a small town the name-match never finds (no exact tier) is
		// still recovered by its postcode's containing locality.
		scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)

		// Conflict flag: if the chosen locality is NOT the postcode's containing locality and sits far
		// from it, the postcode and the city name disagree (a transposed / wrong-for-the-city postcode).
		// We keep the name-chosen locality but flag it — the falsehood signal a BM25 geocoder can't give.
		const top = scored[0]

		if (top) {
			// The postcode's geographic anchor: among the postcode's candidate localities that actually
			// resolved (some — e.g. unnamed Ortsteile — are in the postcode table but not the admin DB),
			// prefer the containing one, else the nearest. Postcodes whose centroid falls just outside
			// every locality polygon still anchor to the closest town.
			const anchorRow = pcRows
				.filter((r) => merged.has(r.id))
				// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
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
	 * Fetch locality spr rows (from main) for the postcode-injected candidate ids the FTS set missed.
	 */
	#fetchLocalitiesByID(ids: number[]): PlaceCandidate[] {
		if (!ids.length) return []
		const hasPop = this.#hasPopulationIndex.get("main") === true
		const popSelect = hasPop ? `pp.population AS population` : `NULL AS population`
		const popJoin = hasPop ? `LEFT JOIN main.${PLACE_POPULATION_TABLE} pp ON pp.id = s.id` : ""
		const ph = ids.map(() => "?").join(", ")

		const rows = allRows<RawSearchRow>(
			this.#db.prepare(
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

	[Symbol.dispose](): void {
		// Only when we opened it. A caller who passed a pre-opened client keeps using it after this returns — the FTS
		// build this lookup performed lives on their connection, and closing it would take that with us.
		this.#resources[Symbol.dispose]()
	}

	/**
	 * Build the FTS5 virtual table from the `names` + `places` tables.
	 */
	#ensureFTS(): void {
		buildPlaceSearchFTS(this.#db)
	}

	#assertFTSExists(): void {
		if (!placeSearchFTSExists(this.#db)) {
			throw new Error(
				"WOFSQLitePlaceLookup: `place_search` FTS5 table is missing. Pass `buildFTS: true` to build it on open, or run `mailwoman gazetteer build fts <path-to-wof.db>` ahead of time (see resolver-wof-sqlite/README.md)."
			)
		}
	}
}

export type { RankingWeights } from "#ranking-weights"
