/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `WofSqlitePlaceLookup` — the resolver implementation backed by `node:sqlite` + a Kysely-typed
 *   query layer where the queries are non-trivial, and raw SQL where they aren't (FTS5 MATCH, the
 *   FTS index build).
 *
 *   See `docs/plan/phases/PHASE_4_2_wof_sqlite.md` for the design rationale.
 */

import { Kysely, sql } from "kysely"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import { SqliteDialect } from "@mailwoman/core/kysley/dialect"

import {
	resolveConvention,
	SeedConventionSource,
	type Convention,
	type ConventionSource,
	type ResolvedConvention,
	type Strategy,
} from "./convention.js"
import {
	buildPlaceSearchFts,
	PLACE_BBOX_TABLE,
	PLACE_POPULATION_TABLE,
	placeBboxExists,
	placePopulationExists,
	placeSearchFtsExists,
} from "./fts.js"
import { bboxAround, haversineKm } from "./geo.js"
import type { WofDatabase } from "./schema.js"
import { pickShardForPlacetype, resolveShards, type ResolvedShard, type ShardConfig } from "./sharding.js"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WofPlacetype } from "./types.js"

export interface WofSqlitePlaceLookupOpts {
	/**
	 * Path to the WOF SQLite distribution on disk. Mutually exclusive with `database`.
	 *
	 * **Single string** — opens that one DB as the main shard.
	 *
	 * **Array** — opens the first entry as main, then ATTACHes each subsequent entry as a separate
	 * SQLite schema. Schema names are derived from the filename (`whosonfirst-data-postalcode-
	 * us-latest.db` → `postalcode_us`); override with `ShardConfig.schemaName` when the filename
	 * doesn't follow WOF convention. See `sharding.ts` for the derivation rules.
	 *
	 * Routing: queries with a `placetype` matching a shard's name (or explicit `placetypes` hint) are
	 * sent to that shard; everything else hits main. Cross-shard UNION is NOT done — BM25 isn't
	 * comparable across separately-indexed corpora.
	 */
	databasePath?: string | ReadonlyArray<string | ShardConfig>
	/**
	 * Pre-opened DatabaseSync — primarily for tests against an inline fixture DB. Mutually exclusive
	 * with `databasePath`. Multi-shard requires `databasePath` (so the lookup owns the ATTACH).
	 */
	database?: DatabaseSync
	/**
	 * If true, build the FTS5 `place_search` virtual table on construction if it doesn't already
	 * exist. The upstream WOF distribution does NOT ship FTS5, so callers either set this once on
	 * first open or pre-build it via the operator-side CLI documented in the README. Default false —
	 * the resolver assumes the index already exists and errors loudly if it doesn't.
	 *
	 * With multi-shard, `buildFts: true` builds the index on the **main** shard only. Other shards
	 * must be pre-built via `mailwoman-wof-build-fts` — operator script for predictable cost.
	 */
	buildFts?: boolean
	/**
	 * Geographic Rule Engine convention source (Direction E, #289). Per-WOF-polygon resolution
	 * profiles, either as a ready `ConventionSource` or a plain `{ wofId: Convention }` seed map.
	 * Default empty — every query rides `WORLD_DEFAULT` (the EU coordinate-first behavior). JP/KR/TW
	 * add rows; #290 wires a build-from-source sqlite-backed source here.
	 */
	conventions?: ConventionSource | Record<number, Convention>
}

/**
 * Ranking weights for `findPlace`. Tweakable per-instance but defaults match the values declared in
 * the Phase 4.2 plan doc.
 */
export interface RankingWeights {
	/** Boost when the candidate's placetype matches an explicit `placetype` filter. */
	placetypeMatchBoost: number
	/** Boost when the candidate is a locality and no explicit placetype was requested. */
	localityImplicitBoost: number
	/** Boost when the candidate's country matches an explicit `country` filter. */
	countryMatchBoost: number
	/** Boost when the candidate is a direct child of the requested `parentId`. */
	directChildBoost: number
	/** Boost when the candidate is a transitive descendant of the requested `parentId`. */
	descendantBoost: number
	/** Multiplier on the length-penalty term (penalizes much-longer-than-query names). */
	lengthPenaltyWeight: number
	/**
	 * Magnitude of the proximity boost when the query carries `near`. The contribution is
	 * `proximityBoost / (1 + distanceKm / proximityScaleKm)` — at distance 0 the boost is full
	 * magnitude, at `proximityScaleKm` it's half, decaying further with distance. Default tuned so
	 * proximity can overcome a typical FTS rank tie but not dominate a strong text match.
	 */
	proximityBoost: number
	/** Distance (km) at which the proximity boost halves. Tune to the typical query radius. */
	proximityScaleKm: number
	/**
	 * Magnitude of the population boost when the candidate has a known `wof:population`. The
	 * contribution is `populationBoost * log10(1 + population) / populationScaleLog10`, capped at
	 * `populationBoost`. WOF only carries population for ~15% of localities (mostly larger ones);
	 * places without it get +0 (never a penalty). Default tuned so the famous Springfield, IL (pop
	 * ~112k) gets ~0.42 boost — enough to nudge past tiny same-name peers.
	 */
	populationBoost: number
	/**
	 * Population (in log10) at which the boost reaches its full magnitude. Default 6 — i.e. a
	 * population of 1,000,000 gives `populationBoost` exactly. Larger populations cap at the same
	 * value (no compounding effect for megacities).
	 */
	populationScaleLog10: number
	/**
	 * Tier candidates with an EXACT name/alias match above candidates that only match partially,
	 * BEFORE the weighted-sum score is consulted. Default true.
	 *
	 * Why this is needed (and why it ALIGNS with — rather than overrides — the population/importance
	 * signal): the weighted sum adds population as a large additive boost (`populationBoost`, up to
	 * +4) so that famous places surface for unambiguous full-name queries. But population is a
	 * _prominence prior_ — its job is to break ties among candidates that match the query EQUALLY
	 * WELL (e.g. "Springfield" → Springfield IL over Springfield MA, both exact name matches). It was
	 * never meant to promote a place that matches the query WORSE. For a 2-letter region abbreviation
	 * that backfires: querying "ME" returns Maine (which has the exact alias `ME`) AND Missouri/
	 * Michigan/etc. (which do not), and Missouri's larger population (+4) overcomes Maine's bm25 edge
	 * — so "Portland, ME" resolves its region to Missouri and the locality then cascades to the wrong
	 * state. Tiering restores the intended ordering: **match quality is the primary key, prominence
	 * (population) the secondary key WITHIN a tier.** Springfield-IL-over-MA still works (both exact
	 * → same tier → population decides); ME→Maine now works (only Maine is exact → higher tier →
	 * population never gets to override it). See
	 * docs/articles/evals/2026-05-30-resolver-exact-match.md.
	 *
	 * Note: tiering re-ranks within the over-fetched candidate window (`limit * 4`); a pathological
	 * exact match that falls outside that window is not rescued. For the region-abbrev case the
	 * window is comfortably sufficient (a handful of states match a 2-letter query).
	 */
	exactMatchTiering: boolean
}

const DEFAULT_WEIGHTS: RankingWeights = {
	placetypeMatchBoost: 0.5,
	localityImplicitBoost: 0.2,
	countryMatchBoost: 0.3,
	directChildBoost: 0.5,
	descendantBoost: 0.2,
	lengthPenaltyWeight: 0.1,
	proximityBoost: 0.8,
	proximityScaleKm: 100,
	// populationBoost is intentionally large — empirical tuning against real WOF showed BM25 gaps
	// of 1.5-3.0 between famous places and tiny same-name peers (because the famous ones have
	// hundreds of alt-name entries that hurt their FTS document score). To consistently surface
	// "the famous one" for unambiguous queries like "New York" or "Chicago", the population signal
	// needs to dominate. Callers wanting a more conservative balance can drop this in the
	// RankingWeights override.
	//
	// Note: this resolver uses `place_population` directly. The separate `place_importance` table
	// (Wikipedia-derived) is consumed by the FST layer, not here. See
	// docs/articles/concepts/importance-vs-population.md for the two-signal contract.
	populationBoost: 4.0,
	populationScaleLog10: 6,
	// Exact name/alias match outranks partial match before the weighted sum (incl. population) is
	// consulted — keeps population as an intra-tier prominence tiebreaker, not a cross-tier promoter.
	// Fixes the 2-letter-region-abbrev bug ("ME" → Maine, not the more-populous Missouri).
	exactMatchTiering: true,
}

interface RawSearchRow {
	id: number
	name: string
	placetype: string
	country: string | null
	parent_id: number | null
	rank: number // BM25 (lower = better in SQLite); we negate to get higher-is-better
	lat: number | null
	lon: number | null
	population: number | null // from the place_population aux table; null when missing
}

/**
 * The coordinate-first candidate table (scripts/build-postcode-locality.py): postcode → containing
 * + nearby localities with WOF alt-name aliases.
 */
const POSTCODE_LOCALITY_TABLE = "postcode_locality"

/**
 * Tunables for the coordinate-first locality soft-score `Score = pc·S_pc + name·S_name + pop·S_pop`
 * (each S in [0,1]). The pc/name/pop WEIGHTS now come from the resolved convention's
 * `scoringWeights` (`WORLD_DEFAULT` = 0.6/0.3/0.1 — the EU values), so a locale can retune them as
 * data. PC_DECAY_KM sets how fast S_pc falls with distance.
 */
const CF_PC_DECAY_KM = 8
/**
 * The chosen locality must be within this distance of the postcode's containing locality, else the
 * postcode and the parsed city name are judged to disagree (a transposed / wrong-for-the-city
 * postcode) and the `mismatch` flag fires. Generous enough that a city-state Ortsteil (~15km from
 * the city centroid) and an abutting town (~few km) are NOT flagged, tight enough to catch a wrong
 * city (hundreds of km).
 */
const CF_MISMATCH_KM = 50
const CF_MISMATCH_DELTA = 0.5

/** Case-fold + strip diacritics + collapse punctuation — for the coord-first soft name match. */
function cfNormalize(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // combining diacritical marks
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

/** Padded character-trigram set (a leading/trailing space pads short tokens). */
function trigrams(s: string): Set<string> {
	const t = ` ${s} `
	const out = new Set<string>()
	for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
	return out
}

/**
 * Character-trigram Jaccard ∈ [0,1] — tolerant of the swallowed-leading-char fragments ("auen" vs
 * "plauen") and minor misspellings without a heavyweight edit-distance pass.
 */
function trigramJaccard(a: string, b: string): number {
	const A = trigrams(a)
	const B = trigrams(b)
	if (A.size === 0 || B.size === 0) return 0
	let inter = 0
	for (const x of A) if (B.has(x)) inter++
	return inter / (A.size + B.size - inter)
}

/** Soft name-match score ∈ [0,1]: exact (normalized) name/alias → 1, else best trigram-Jaccard. */
function softNameScore(text: string, name: string, aliases: readonly string[]): number {
	const q = cfNormalize(text)
	if (!q) return 0
	let best = 0
	for (const raw of [name, ...aliases]) {
		const n = cfNormalize(raw)
		if (!n) continue
		if (n === q) return 1
		best = Math.max(best, trigramJaccard(q, n))
	}
	return best
}

export class WofSqlitePlaceLookup implements PlaceLookup, Disposable {
	readonly #db: DatabaseSync
	readonly #ownsDb: boolean
	readonly #kysely: Kysely<WofDatabase>
	readonly #weights: RankingWeights
	/**
	 * Cached at construction so we don't `sqlite_master` query on every findPlace call. Bbox + near-
	 * with-radius queries fall back to no-filter when this is false, preserving compatibility with
	 * DBs that were FTS-built before the R*Tree shipped.
	 *
	 * Per-shard: a shard is only considered to have the bbox index if its own R*Tree table exists.
	 */
	readonly #hasBboxIndex: Map<string, boolean>
	/**
	 * Per-shard probe for the `place_population` aux table. When false, the LEFT JOIN is omitted from
	 * the SELECT and population boost is 0 for every row — preserves compatibility with DBs built
	 * before this feature shipped.
	 */
	readonly #hasPopulationIndex: Map<string, boolean>
	/**
	 * Per-shard probe for the `postcode_locality` table (the coordinate-first candidate table, built
	 * by scripts/build-postcode-locality.py). Cached at construction; null'd out when absent so the
	 * coord-first path silently no-ops on a deployment that didn't ship the table.
	 */
	readonly #postcodeLocalityShard: string | null
	/**
	 * Resolved shard list. Always at least one entry; first is `main`. Multi-shard adds extras with
	 * their own derived (or override) schema names.
	 */
	readonly #shards: ResolvedShard[]
	/**
	 * The Geographic Rule Engine (Direction E, #289). `#conventionSource` supplies per-WOF-polygon
	 * resolution profiles; `#strategies` is the named-primitive registry the merged convention
	 * dispatches. Empty source → every query resolves to `WORLD_DEFAULT` → byte-identical to the
	 * pre-engine coordinate-first path. `#countryWofIdCache` memoizes the country-code →
	 * country-WOF-id lookup that seeds the convention ancestor chain (one query per country, then
	 * cached).
	 */
	readonly #conventionSource: ConventionSource
	readonly #strategies: Map<string, Strategy>
	readonly #countryWofIdCache = new Map<string, number | null>()

	constructor(opts: WofSqlitePlaceLookupOpts, weights?: Partial<RankingWeights>) {
		if (opts.database && opts.databasePath) {
			throw new Error("WofSqlitePlaceLookup: pass either `database` or `databasePath`, not both")
		}
		if (!opts.database && !opts.databasePath) {
			throw new Error("WofSqlitePlaceLookup: one of `database` or `databasePath` is required")
		}

		if (opts.database) {
			this.#db = opts.database
			this.#ownsDb = false
			this.#shards = [{ path: ":memory:", schemaName: "main", placetypes: [] }]
		} else {
			const shards = resolveShards(opts.databasePath!)
			this.#shards = shards
			this.#db = new DatabaseSync(shards[0]!.path, { readOnly: false })
			this.#ownsDb = true
			// ATTACH each non-main shard. Schema names were validated by resolveShards, so safe to
			// interpolate directly (SQLite ATTACH doesn't accept parameters for the schema name).
			for (const s of shards.slice(1)) {
				this.#db.exec(`ATTACH DATABASE '${s.path.replace(/'/g, "''")}' AS ${s.schemaName}`)
			}
		}

		// node:sqlite has no .pragma() helper; pragmas are executed as plain SQL.
		this.#db.exec("PRAGMA busy_timeout = 5000")

		if (opts.buildFts) {
			this.#ensureFts()
		} else {
			this.#assertFtsExists()
		}

		this.#kysely = new Kysely<WofDatabase>({
			dialect: new SqliteDialect({ database: this.#db }),
		})
		this.#weights = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) }

		// Probe each shard's aux-table presence — driven by per-shard table existence in
		// sqlite_master. Cached at construction so findPlace doesn't query sqlite_master per call.
		this.#hasBboxIndex = new Map()
		this.#hasPopulationIndex = new Map()
		for (const s of this.#shards) {
			this.#hasBboxIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_BBOX_TABLE))
			this.#hasPopulationIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_POPULATION_TABLE))
		}
		// The postcode_locality table can live on any attached shard (typically its own
		// `postcode-locality-<cc>.db`). Find the first shard that has it; null = coord-first disabled.
		this.#postcodeLocalityShard =
			this.#shards.find((s) => this.#shardHasTable(s.schemaName, POSTCODE_LOCALITY_TABLE))?.schemaName ?? null

		// The Geographic Rule Engine. Source defaults empty (EU rides WORLD_DEFAULT); callers inject
		// per-WOF-polygon profiles via `opts.conventions` (#290 wires a sqlite-backed source, JP/KR/TW add
		// rows). The registry binds strategy NAMES to the SQL-bound primitives below — adding a strategy
		// is registering it here.
		this.#conventionSource =
			opts.conventions && "get" in opts.conventions && typeof opts.conventions.get === "function"
				? opts.conventions
				: new SeedConventionSource((opts.conventions as Record<number, Convention>) ?? {})
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
		for (const name of convention.candidateStrategies) {
			const strategy = this.#strategies.get(name)
			if (!strategy) continue
			const result = await strategy(query, convention)
			if (result !== null) return result
		}
		return []
	}

	/**
	 * Strategy `postcode_area_resolution` — the coordinate-first locality path, strictly gated (a
	 * sibling postcode AND a postcode_locality table AND a locality query). Returns `null` — so the
	 * dispatcher falls through to the next strategy — when the gate is unmet or the postcode isn't in
	 * the table; otherwise the soft-scored postcode∪name candidate set.
	 */
	#postcodeAreaResolution(query: FindPlaceQuery, convention: ResolvedConvention): Promise<PlaceCandidate[] | null> {
		if (!(query.postcode && this.#postcodeLocalityShard && this.#isLocalityQuery(query))) {
			return Promise.resolve(null)
		}
		return this.#findLocalityCoordFirst(query, this.#postcodeLocalityShard, convention)
	}

	/**
	 * Strategy `fallback_fuzzy_name_match` — the BM25 FTS name-match over the gazetteer, the
	 * universal fallback. Always returns an array (never null), so it terminates the dispatch chain.
	 */
	async #fuzzyNameMatch(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		const limit = query.limit ?? 10
		const ftsLimit = limit * 4 // over-fetch so post-scoring has room to re-rank

		const placetypes = normalizePlacetypes(query.placetype)
		const ftsQuery = sanitizeFtsQuery(query.text)
		if (!ftsQuery) return []

		// Pick the shard for this query. Multi-shard routing is placetype-driven; a query without
		// `placetype` always goes to main. (Mixed-placetype queries with multiple shards aren't
		// supported in v1 — caller can issue two findPlace calls and merge in TS if needed.)
		const firstPlacetype = placetypes?.[0]
		const shard = pickShardForPlacetype(this.#shards, firstPlacetype)
		const sch = shard.schemaName // bare schema name; safe to interpolate (validated at construction)

		// Filter out historical / superseded / deprecated places by default — they live in the same
		// spr table but should never win a contemporary lookup. `is_current = 0` is the only WOF
		// value that means "not current"; both `-1` (modern) and `1` (legacy) mean current. See #91.
		// Note: with schema-qualified FROM the bare `place_search` reference in MATCH resolves to
		// the FROM table — required by FTS5 parser, see sharding.ts header comment.
		const where: string[] = ["place_search MATCH ?", "spr.is_current != 0", "spr.is_deprecated = 0"]
		const params: SQLInputValue[] = [ftsQuery]

		if (placetypes && placetypes.length > 0) {
			where.push(`spr.placetype IN (${placetypes.map(() => "?").join(", ")})`)
			params.push(...placetypes)
		}
		if (query.country) {
			where.push("spr.country = ?")
			params.push(query.country)
		}
		if (query.parentId !== undefined) {
			where.push(`(spr.parent_id = ? OR spr.id IN (SELECT id FROM ${sch}.ancestors WHERE ancestor_id = ?))`)
			params.push(query.parentId, query.parentId)
		}

		// Bbox + near-with-radius are SQL-level filters via the R*Tree. We only emit the JOIN when
		// the active shard has the R*Tree; missing-but-requested is silently treated as no-bbox-
		// filter so legacy DBs / shards-without-bbox don't crash.
		const shardHasBbox = this.#hasBboxIndex.get(sch) === true
		const useBboxJoin = (query.bbox || query.near?.maxDistanceKm !== undefined) && shardHasBbox
		let joinClause = `JOIN ${sch}.spr ON spr.id = place_search.wof_id`
		if (useBboxJoin) {
			joinClause += ` JOIN ${sch}.${PLACE_BBOX_TABLE} bbox ON bbox.id = spr.id`
			// AABB intersection — both bbox sides must overlap. R*Tree handles this in O(log n).
			const filterBox = query.bbox
				? query.bbox
				: bboxAround(query.near!.lat, query.near!.lon, query.near!.maxDistanceKm!)
			where.push("bbox.min_lat <= ? AND bbox.max_lat >= ?", "bbox.min_lon <= ? AND bbox.max_lon >= ?")
			params.push(filterBox.maxLat, filterBox.minLat, filterBox.maxLon, filterBox.minLon)
		}

		// LEFT JOIN the population aux table when present. Missing-on-this-shard means the SELECT
		// just doesn't include the population column; the post-scoring loop treats it as 0.
		const shardHasPopulation = this.#hasPopulationIndex.get(sch) === true
		const populationSelect = shardHasPopulation
			? `${PLACE_POPULATION_TABLE}.population AS population`
			: `NULL AS population`
		const populationJoin = shardHasPopulation
			? `LEFT JOIN ${sch}.${PLACE_POPULATION_TABLE} ON ${PLACE_POPULATION_TABLE}.id = spr.id`
			: ""

		// Push the population boost into the ORDER BY when the index is available, so famous places
		// (whose long alt-name lists hurt BM25) actually make it into the over-fetch window. The TS
		// post-scoring will still compute the same boost for the final score; this just ensures the
		// candidate set is right.
		//
		// Formula: rank_adjusted = bm25 - populationBoost * min(1.0, log10(1 + pop) / scaleLog10)
		// Lower rank_adjusted = better (matches SQLite's bm25 convention of "more negative = better").
		const orderByExpr = shardHasPopulation
			? `(bm25(place_search) - ? * MIN(1.0, COALESCE(log10(1.0 + ${PLACE_POPULATION_TABLE}.population), 0) / ?))`
			: "bm25(place_search)"

		// Schema-qualified FROM with bare-name MATCH — required syntax for FTS5 on attached schemas.
		// See sharding.ts header for the gotcha that drove this design.
		const stmt = this.#db.prepare(`
			SELECT
				spr.id AS id,
				spr.name,
				spr.placetype,
				spr.country,
				spr.parent_id,
				bm25(place_search) AS rank,
				spr.latitude AS lat,
				spr.longitude AS lon,
				${populationSelect}
			FROM ${sch}.place_search
			${joinClause}
			${populationJoin}
			WHERE ${where.join(" AND ")}
			ORDER BY ${orderByExpr} ASC
			LIMIT ?
		`)
		if (shardHasPopulation) {
			params.push(this.#weights.populationBoost, this.#weights.populationScaleLog10)
		}
		params.push(ftsLimit)

		const rawRows = stmt.all(...params) as unknown as RawSearchRow[]

		const queryLen = query.text.length
		const candidates = rawRows.map((row): PlaceCandidate => {
			// SQLite's bm25() returns a lower-is-better score (negative for matches). Negate so we
			// start from a higher-is-better baseline.
			let score = -row.rank
			if (placetypes && placetypes.length > 0 && placetypes.includes(row.placetype as WofPlacetype)) {
				score += this.#weights.placetypeMatchBoost
			}
			if (!placetypes && row.placetype === "locality") {
				score += this.#weights.localityImplicitBoost
			}
			if (query.country && row.country === query.country) {
				score += this.#weights.countryMatchBoost
			}
			if (query.parentId !== undefined) {
				if (row.parent_id === query.parentId) {
					score += this.#weights.directChildBoost
				} else {
					score += this.#weights.descendantBoost
				}
			}
			const extraLen = Math.max(0, row.name.length - queryLen - 3)
			score -= (this.#weights.lengthPenaltyWeight * extraLen) / 10

			// Proximity boost: only applied when the query carries `near` AND the candidate has real
			// coordinates. The formula decays smoothly with distance so close-but-not-exact hits
			// still benefit; tunable via proximityBoost + proximityScaleKm.
			let distanceKm: number | undefined
			if (query.near && row.lat !== null && row.lon !== null && !(row.lat === 0 && row.lon === 0)) {
				distanceKm = haversineKm(query.near.lat, query.near.lon, row.lat, row.lon)
				score += this.#weights.proximityBoost / (1 + distanceKm / this.#weights.proximityScaleKm)
			}

			// Population boost: capped at `populationBoost` magnitude at `10^populationScaleLog10`
			// people. Missing population → no contribution. Never penalizes.
			if (row.population !== null && row.population > 0 && this.#weights.populationScaleLog10 > 0) {
				const popLog = Math.log10(1 + row.population)
				const popFraction = Math.min(1, popLog / this.#weights.populationScaleLog10)
				score += this.#weights.populationBoost * popFraction
			}

			const candidate: PlaceCandidate = {
				id: row.id,
				name: row.name,
				placetype: row.placetype as WofPlacetype,
				country: row.country ?? "",
				lat: row.lat ?? 0,
				lon: row.lon ?? 0,
				parent_id: row.parent_id ?? undefined,
				score,
			}
			if (distanceKm !== undefined) candidate.distanceKm = distanceKm
			if (row.population !== null && row.population > 0) candidate.population = row.population
			return candidate
		})

		// Exact-match tiering: a candidate whose name OR any alias equals the query text (case-folded)
		// ranks above any partial match, with the weighted-sum score (incl. population) breaking ties
		// WITHIN a tier. See the RankingWeights.exactMatchTiering docstring for why this aligns the
		// population prior rather than overriding it. One cheap indexed lookup over the candidate ids.
		if (this.#weights.exactMatchTiering && candidates.length > 1) {
			const exactIds = this.#exactMatchIds(
				sch,
				candidates.map((c) => c.id as number),
				query.text
			)
			if (exactIds.size > 0 && exactIds.size < candidates.length) {
				candidates.sort((a, b) => {
					const ax = exactIds.has(a.id as number) ? 1 : 0
					const bx = exactIds.has(b.id as number) ? 1 : 0
					return bx - ax || b.score - a.score
				})
				return Promise.resolve(candidates.slice(0, limit))
			}
		}

		candidates.sort((a, b) => b.score - a.score)
		return Promise.resolve(candidates.slice(0, limit))
	}

	#isLocalityQuery(query: FindPlaceQuery): boolean {
		const pts = normalizePlacetypes(query.placetype)
		return !pts || pts.includes("locality")
	}

	/**
	 * Resolve the effective convention for a query (the Geographic Rule Engine entry point). The
	 * ancestor chain is keyed by WOF polygon id; for #289 it carries just the country level —
	 * resolved from `query.country` via the cached code→WOF-id lookup — so the EU locales, which have
	 * no override rows, resolve to `WORLD_DEFAULT` and dispatch is byte-identical to the pre-engine
	 * path. E4 (JP) extends the chain with the resolved locality's `ancestors` row, so a
	 * region/locality-level convention (e.g. Sapporo's grid) deep-merges over the country one.
	 */
	#conventionFor(query: FindPlaceQuery): ResolvedConvention {
		const chain: number[] = []
		if (query.country) {
			const cid = this.#countryWofId(query.country)
			if (cid !== null) chain.push(cid)
		}
		return resolveConvention(this.#conventionSource, chain)
	}

	/**
	 * Country ISO code → its WOF polygon id (the coarsest convention key). Cached — one indexed `spr`
	 * query per distinct country, then memoized (including a not-found `null`) so findPlace never
	 * pays for it twice.
	 */
	#countryWofId(code: string): number | null {
		const cached = this.#countryWofIdCache.get(code)
		if (cached !== undefined) return cached
		let id: number | null = null
		try {
			const row = this.#db
				.prepare(`SELECT id FROM main.spr WHERE placetype = 'country' AND country = ? AND is_current != 0 LIMIT 1`)
				.get(code) as { id: number } | undefined
			id = row?.id ?? null
		} catch {
			id = null
		}
		this.#countryWofIdCache.set(code, id)
		return id
	}

	/**
	 * Coordinate-first locality resolution. The postcode_locality table maps the sibling postcode to
	 * the locality whose polygon contains the postcode centroid (+ a few nearby ones for the
	 * abutting- postcode case). We union those COORDINATE candidates with the FTS NAME candidates and
	 * soft-score the union `0.6·S_pc + 0.3·S_name + 0.1·S_pop` — so a small town the name-match never
	 * finds is recovered by the postcode, while an unambiguous name (Berlin) still wins on name +
	 * population. Returns null when the postcode isn't in the table (→ caller falls back to the FTS
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
		const pcRows = this.#db
			.prepare(
				`SELECT locality_id AS id, aliases, distance_km AS dist, is_containing AS containing
				 FROM ${sch}.${POSTCODE_LOCALITY_TABLE} WHERE ${pcWhere}`
			)
			.all(...pcParams) as unknown as Array<{ id: number; aliases: string | null; dist: number; containing: number }>
		if (pcRows.length === 0) return null

		const limit = query.limit ?? 10
		// Name-match candidates via the normal FTS path (postcode cleared → no recursion).
		const ftsCands = await this.findPlace({ ...query, postcode: undefined, limit: Math.max(limit, 10) })

		const pcInfo = new Map<number, { dist: number; containing: boolean; aliases: string[] }>()
		for (const r of pcRows) {
			pcInfo.set(r.id, { dist: r.dist, containing: r.containing === 1, aliases: r.aliases ? r.aliases.split("|") : [] })
		}

		const merged = new Map<number, PlaceCandidate>()
		for (const c of ftsCands) merged.set(c.id as number, c)
		const missing = [...pcInfo.keys()].filter((id) => !merged.has(id))
		for (const row of this.#fetchLocalitiesById(missing)) merged.set(row.id, row)

		const scored: Array<PlaceCandidate & { exact: boolean }> = []
		for (const cand of merged.values()) {
			const info = pcInfo.get(cand.id as number)
			const sPc = info ? (info.containing ? 1 : Math.exp(-info.dist / CF_PC_DECAY_KM)) : 0
			const sName = softNameScore(query.text, cand.name, info?.aliases ?? [])
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
				.sort((a, b) => b.containing - a.containing || a.dist - b.dist)[0]
			const anchor = anchorRow ? merged.get(anchorRow.id) : undefined
			if (anchor && (top.id as number) !== anchorRow!.id) {
				if (haversineKm(top.lat, top.lon, anchor.lat, anchor.lon) > CF_MISMATCH_KM) top.mismatch = true
			}
		}

		return scored.slice(0, limit).map(({ exact, ...c }) => {
			void exact
			return c
		})
	}

	/** Fetch locality spr rows (from main) for the postcode-injected candidate ids the FTS set missed. */
	#fetchLocalitiesById(ids: number[]): PlaceCandidate[] {
		if (ids.length === 0) return []
		const hasPop = this.#hasPopulationIndex.get("main") === true
		const popSelect = hasPop ? `pp.population AS population` : `NULL AS population`
		const popJoin = hasPop ? `LEFT JOIN main.${PLACE_POPULATION_TABLE} pp ON pp.id = s.id` : ""
		const ph = ids.map(() => "?").join(", ")
		const rows = this.#db
			.prepare(
				`SELECT s.id AS id, s.name AS name, s.country AS country, s.parent_id AS parent_id,
				        s.latitude AS lat, s.longitude AS lon, ${popSelect}
				 FROM main.spr s ${popJoin}
				 WHERE s.id IN (${ph}) AND s.is_current != 0`
			)
			.all(...ids) as unknown as Array<RawSearchRow>
		return rows.map((row) => {
			const c: PlaceCandidate = {
				id: row.id,
				name: row.name,
				placetype: "locality",
				country: row.country ?? "",
				lat: row.lat ?? 0,
				lon: row.lon ?? 0,
				parent_id: row.parent_id ?? undefined,
				score: 0,
			}
			if (row.population !== null && row.population > 0) c.population = row.population
			return c
		})
	}

	/**
	 * Among `ids`, return the subset whose name OR any alias equals `text` case-insensitively — the
	 * exact-match tier for ranking. One indexed query over `<schema>.names`. Returns an empty set
	 * when the shard has no `names` table (e.g. a postcode-only shard), so tiering silently no-ops
	 * there.
	 */
	#exactMatchIds(schemaName: string, ids: number[], text: string): Set<number> {
		const out = new Set<number>()
		const trimmed = text.trim()
		if (ids.length === 0 || !trimmed) return out
		try {
			const placeholders = ids.map(() => "?").join(", ")
			const rows = this.#db
				.prepare(
					`SELECT DISTINCT id FROM ${schemaName}.names WHERE id IN (${placeholders}) AND name = ? COLLATE NOCASE`
				)
				.all(...ids, trimmed) as Array<{ id: number }>
			for (const r of rows) out.add(r.id)
		} catch {
			// Shard without a `names` table → no exact-match tier. Falls back to weighted-sum order.
		}
		return out
	}

	close(): void {
		// Destroying the Kysely instance closes the underlying connection IF we own it. If the caller
		// passed in a pre-opened DatabaseSync (test fixture), respect their ownership.
		void this.#kysely.destroy()
		if (this.#ownsDb) {
			this.#db.close()
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}

	/** Build the FTS5 virtual table from the `names` + `places` tables. */
	#ensureFts(): void {
		buildPlaceSearchFts(this.#db)
	}

	#assertFtsExists(): void {
		if (!placeSearchFtsExists(this.#db)) {
			throw new Error(
				"WofSqlitePlaceLookup: `place_search` FTS5 table is missing. Pass `buildFts: true` to build it on open, or run `mailwoman-wof-build-fts <path-to-wof.db>` ahead of time (see resolver-wof-sqlite/README.md)."
			)
		}
	}
}

function normalizePlacetypes(p: FindPlaceQuery["placetype"]): WofPlacetype[] | null {
	if (!p) return null
	return Array.isArray(p) ? p : [p]
}

/**
 * Make an arbitrary user-typed string safe for FTS5 MATCH.
 *
 * FTS5 has its own query syntax (`"phrase"`, `term1 OR term2`, `prefix*`, NEAR/N, etc.). Letting
 * raw user input through means a user typing `Paris's` or `St. (Petersburg)` causes a syntax
 * error.
 *
 * Per-token rules:
 *
 * - Strip all punctuation except trailing `*` from each whitespace-separated token.
 * - **Trailing `*`** is preserved as FTS5 **prefix syntax** — `627*` becomes the literal `627*`
 *   (unquoted). The caller signaled they want a prefix; respect that.
 * - All other tokens are wrapped in `"..."` as a single-word phrase. Conservative — handles
 *   apostrophes, parens, accented input, etc. safely.
 * - Multiple tokens join with implicit AND.
 *
 * Examples:
 *
 * - `"Paris"` → `"Paris"` (phrase)
 * - `"627*"` → `627*` (prefix)
 * - `"St. (Petersburg)"` → `"St" "Petersburg"` (two phrases, AND-joined)
 * - `"Pari* TX"` → `Pari* "TX"` (mixed prefix + phrase)
 * - `"*"` alone → `""` (no body → drop)
 */
function sanitizeFtsQuery(text: string): string {
	const out: string[] = []
	for (const rawToken of text.normalize("NFKC").split(/\s+/u)) {
		const trimmed = rawToken.trim()
		if (!trimmed) continue
		const hasPrefixStar = trimmed.endsWith("*")
		// Strip everything except letters + numbers from the token body. Apostrophes / hyphens /
		// any embedded `*` all go. The trailing `*` (if any) is reapplied separately below.
		const body = trimmed.replace(/[^\p{L}\p{N}]/gu, "")
		if (!body) continue
		out.push(hasPrefixStar ? `${body}*` : `"${body.replace(/"/g, '""')}"`)
	}
	return out.join(" ")
}

// `sql` is imported only because future Kysely-typed queries will use it; silence "unused" linting.
void sql
