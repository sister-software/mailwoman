/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `WOFSqlitePlaceLookup` — the resolver implementation backed by `node:sqlite` + a Kysely-typed
 *   query layer where the queries are non-trivial, and raw SQL where they aren't (FTS5 MATCH, the
 *   FTS index build).
 *
 *   See `docs/plan/phases/PHASE_4_2_wof_sqlite.md` for the design rationale.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import { SqliteDialect } from "@mailwoman/core/kysley/dialect"
import { expandPlacetypeFilter, type Ancestor, type CoincidentLocality } from "@mailwoman/resolver"
import { Kysely, sql } from "kysely"

import { ancestorLineage } from "./ancestry.js"
import { COINCIDENT_ROLES_TABLE, coincidentRolesExists } from "./coincident-roles.js"
import {
	ADDRESS_CONVENTION_TABLE,
	resolveConvention,
	SeedConventionSource,
	type Convention,
	type ConventionSource,
	type ResolvedConvention,
	type Strategy,
} from "./convention.js"
import {
	aliasBagExactMatch,
	buildPlaceSearchFTS,
	PLACE_BBOX_TABLE,
	PLACE_POPULATION_TABLE,
	placeBboxExists,
	placePopulationExists,
	placeSearchFTSExists,
} from "./fts.js"
import { bboxAround, haversineKm } from "./geo.js"
import type { WOFPostalCityAliasLookup } from "./postal-city-alias-lookup.js"
import type { WOFDatabase } from "./schema.js"
import {
	pickShardForPlacetype,
	pickShardsForPlacetype,
	resolveShards,
	type ResolvedShard,
	type ShardConfig,
} from "./sharding.js"
import { SqliteConventionSource } from "./sqlite-convention-source.js"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "./types.js"

export interface WOFSqlitePlaceLookupOpts {
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
	 * Pre-opened DatabaseSync — primarily for tests against an inline fixture DB. Mutually exclusive with `databasePath`.
	 * Multi-shard requires `databasePath` (so the lookup owns the ATTACH).
	 */
	database?: DatabaseSync
	/**
	 * If true, build the FTS5 `place_search` virtual table on construction if it doesn't already exist. The upstream WOF
	 * distribution does NOT ship FTS5, so callers either set this once on first open or pre-build it via the
	 * operator-side CLI documented in the README. Default false — the resolver assumes the index already exists and
	 * errors loudly if it doesn't.
	 *
	 * With multi-shard, `buildFTS: true` builds the index on the **main** shard only. Other shards must be pre-built via
	 * `mailwoman-wof-build-fts` — operator script for predictable cost.
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
 * Ranking weights for `findPlace`. Tweakable per-instance but defaults match the values declared in the Phase 4.2 plan
 * doc.
 */
export interface RankingWeights {
	/** Boost when the candidate's placetype matches an explicit `placetype` filter. */
	placetypeMatchBoost: number
	/** Boost when the candidate is a locality and no explicit placetype was requested. */
	localityImplicitBoost: number
	/** Boost when the candidate's country matches an explicit `country` filter. */
	countryMatchBoost: number
	/** Boost when the candidate is a direct child of the requested `parentID`. */
	directChildBoost: number
	/** Boost when the candidate is a transitive descendant of the requested `parentID`. */
	descendantBoost: number
	/** Multiplier on the length-penalty term (penalizes much-longer-than-query names). */
	lengthPenaltyWeight: number
	/**
	 * Magnitude of the proximity boost when the query carries `near`. The contribution is `proximityBoost / (1 +
	 * distanceKm / proximityScaleKm)` — at distance 0 the boost is full magnitude, at `proximityScaleKm` it's half,
	 * decaying further with distance. Default tuned so proximity can overcome a typical FTS rank tie but not dominate a
	 * strong text match.
	 */
	proximityBoost: number
	/**
	 * Magnitude of the bias-hint term inside the exact-tier PROMINENCE sort (the `bias`/viewport path). Deliberately
	 * population-scale (default = populationBoost) so a candidate near the map view / the user beats a distant-but-bigger
	 * namesake — "the map view wins" is the feature; same-region ties (all candidates far from every hint) still fall to
	 * population.
	 */
	biasBoost: number
	/** Distance (km) at which the proximity boost halves. Tune to the typical query radius. */
	proximityScaleKm: number
	/**
	 * Magnitude of the population boost when the candidate has a known `wof:population`. The contribution is
	 * `populationBoost * log10(1 + population) / populationScaleLog10`, capped at `populationBoost`. WOF only carries
	 * population for ~15% of localities (mostly larger ones); places without it get +0 (never a penalty). Default tuned
	 * so the famous Springfield, IL (pop ~112k) gets ~0.42 boost — enough to nudge past tiny same-name peers.
	 */
	populationBoost: number
	/**
	 * Population (in log10) at which the boost reaches its full magnitude. Default 6 — i.e. a population of 1,000,000
	 * gives `populationBoost` exactly. Larger populations cap at the same value (no compounding effect for megacities).
	 */
	populationScaleLog10: number
	/**
	 * Tier candidates with an EXACT name/alias match above candidates that only match partially, BEFORE the weighted-sum
	 * score is consulted. Default true.
	 *
	 * Why this is needed (and why it ALIGNS with — rather than overrides — the population/importance signal): the
	 * weighted sum adds population as a large additive boost (`populationBoost`, up to +4) so that famous places surface
	 * for unambiguous full-name queries. But population is a _prominence prior_ — its job is to break ties among
	 * candidates that match the query EQUALLY WELL (e.g. "Springfield" → Springfield IL over Springfield MA, both exact
	 * name matches). It was never meant to promote a place that matches the query WORSE. For a 2-letter region
	 * abbreviation that backfires: querying "ME" returns Maine (which has the exact alias `ME`) AND Missouri/
	 * Michigan/etc. (which do not), and Missouri's larger population (+4) overcomes Maine's bm25 edge — so "Portland, ME"
	 * resolves its region to Missouri and the locality then cascades to the wrong state. Tiering restores the intended
	 * ordering: **match quality is the primary key, prominence (population) the secondary key WITHIN a tier.**
	 * Springfield-IL-over-MA still works (both exact → same tier → population decides); ME→Maine now works (only Maine is
	 * exact → higher tier → population never gets to override it). See
	 * docs/articles/evals/2026-05-30-resolver-exact-match.md.
	 *
	 * Note: tiering re-ranks within the over-fetched candidate window (`limit * 4`); a pathological exact match that
	 * falls outside that window is not rescued. For the region-abbrev case the window is comfortably sufficient (a
	 * handful of states match a 2-letter query).
	 */
	exactMatchTiering: boolean
	/**
	 * #936 option 3 — official-language names ARE names. When true, a candidate holding the query as an OFFICIAL name
	 * (`names.official = 1`: a preferred-form name in an official language of its country, stamped at ingest) joins the
	 * NAME-exact sub-tier rather than the alias-exact one, provided its population clears {@link officialNameExactFloor}.
	 * Fixes unscoped "Åbo" → Turku (its official Swedish name) over a hamlet literally named Åbo; population still orders
	 * within the sub-tier, so Paris → Paris FR is untouched.
	 *
	 * Default false (byte-stable). Requires a gazetteer built with the #940 ingest bit — on older DBs without the
	 * `official` column the probe fails soft and behavior is identical to the flag being off.
	 */
	officialNameExact: boolean
	/**
	 * Minimum population for a candidate's official names to join the name-exact sub-tier. The #936 review's no-floor
	 * census measured the boundary: ≥100k holders are the famous-exonym class (757 flips, intent-correct; 7 collisions,
	 * none harmful) while 10k–100k holders are junk-dominated (3,481 flips led by short-form mis-tags — Villeneuve-Loubet
	 * carrying "villeneuve" would bury five real villages of that name). Rank-time knob: tunable without re-ingest;
	 * below-floor official names simply stay alias-tier (today's behavior).
	 */
	officialNameExactFloor: number
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
	biasBoost: 4.0,
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
	// #936 option 3 ships default-OFF behind its gate battery; see the RankingWeights docstring.
	officialNameExact: false,
	officialNameExactFloor: 100_000,
}

/**
 * Over-fetch floor for SHORT (≤3-char) queries — region abbreviations like "NY"/"VT". An exact-abbrev holder's BM25 is
 * poor (long multilingual alt-name document), so the normal `limit * 4` window can drop it before `exactMatchTiering`
 * promotes it. 200 comfortably covers every same-abbrev region across the 12-country gazetteer (a 2-letter token
 * matches a few dozen regions at most) while staying a cheap region-placetype fetch. See the `#fuzzyNameMatch`
 * over-fetch comment.
 */
const SHORT_QUERY_OVERFETCH = 200

/**
 * How many rows the population-ordered companion fetch (#905) adds to the candidate pool. Small on purpose: its only
 * job is to guarantee the FAMOUS holders of a name enter the pool at all — for "Paris"-class floods the bm25 window is
 * saturated by thousands of tiny same-name rows and no boost inside the bm25-based ORDER BY can rescue a candidate
 * whose bm25 is length-poisoned by ~15 points (see the fetch-site comment).
 */
const POPULATION_FETCH_LIMIT = 15

interface RawSearchRow {
	id: number
	name: string
	placetype: string
	country: string | null
	parent_id: number | null
	rank: number // BM25 (lower = better in SQLite); we negate to get higher-is-better
	lat: number | null
	lon: number | null
	min_latitude: number | null
	max_latitude: number | null
	min_longitude: number | null
	max_longitude: number | null
	population: number | null // from the place_population aux table; null when missing
}

/**
 * The coordinate-first candidate table (scripts/build-postcode-locality.ts): postcode → containing
 *
 * - Nearby localities with WOF alt-name aliases.
 */
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
export function trigrams(s: string): Set<string> {
	const t = ` ${s} `
	const out = new Set<string>()

	for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))

	return out
}

/**
 * Character-trigram Jaccard ∈ [0,1] — tolerant of the swallowed-leading-char fragments ("auen" vs "plauen") and minor
 * misspellings without a heavyweight edit-distance pass. Shared with the candidate backend's FTS5-trigram fuzzy
 * fallback so both lookups rank typos identically.
 */
export function trigramJaccard(a: string, b: string): number {
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

export class WOFSqlitePlaceLookup implements PlaceLookup, Disposable {
	readonly #db: DatabaseSync
	readonly #ownsDB: boolean
	readonly #kysely: Kysely<WOFDatabase>
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
	/** #920: per-schema probed country sets for country-aware shard routing (non-main shards only). */
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
	/** Strategy names already warned about — so an unknown name surfaces once, not once per query. */
	readonly #warnedUnknownStrategies = new Set<string>()
	/**
	 * Lazily-built `admin_id → coincident localities` map from the #403 relation (null until first use).
	 */
	#coincidentRolesCache: Map<number, CoincidentLocality[]> | null = null
	/** Per-id memoized ancestor lineages (#404) — a hot chain is queried once. */
	readonly #ancestorsCache = new Map<number, Ancestor[]>()
	/**
	 * Opt-in postal-city alias reader (#475). `null` unless `opts.postalCityAliases` was supplied — every alias code path
	 * is gated on this, so the default resolver is byte-identical.
	 */
	readonly #postalCityAliases: WOFPostalCityAliasLookup | null

	constructor(opts: WOFSqlitePlaceLookupOpts, weights?: Partial<RankingWeights>) {
		if (opts.database && opts.databasePath) {
			throw new Error("WOFSqlitePlaceLookup: pass either `database` or `databasePath`, not both")
		}

		if (!opts.database && !opts.databasePath) {
			throw new Error("WOFSqlitePlaceLookup: one of `database` or `databasePath` is required")
		}

		if (opts.database) {
			this.#db = opts.database
			this.#ownsDB = false
			this.#shards = [{ path: ":memory:", schemaName: "main", placetypes: [] }]
		} else {
			const shards = resolveShards(opts.databasePath!)
			this.#shards = shards
			this.#db = new DatabaseSync(shards[0]!.path, { readOnly: false })
			this.#ownsDB = true

			// ATTACH each non-main shard. Schema names were validated by resolveShards, so safe to
			// interpolate directly (SQLite ATTACH doesn't accept parameters for the schema name).
			for (const s of shards.slice(1)) {
				this.#db.exec(`ATTACH DATABASE '${s.path.replace(/'/g, "''")}' AS ${s.schemaName}`)
			}
		}

		// node:sqlite has no .pragma() helper; pragmas are executed as plain SQL.
		this.#db.exec("PRAGMA busy_timeout = 5000")

		if (opts.buildFTS) {
			this.#ensureFTS()
		} else {
			this.#assertFTSExists()
		}

		this.#kysely = new Kysely<WOFDatabase>({
			dialect: new SqliteDialect({ database: this.#db }),
		})
		this.#weights = { ...DEFAULT_WEIGHTS, ...weights }

		// Probe each shard's aux-table presence — driven by per-shard table existence in
		// sqlite_master. Cached at construction so findPlace doesn't query sqlite_master per call.
		this.#hasBboxIndex = new Map()
		this.#hasPopulationIndex = new Map()

		for (const s of this.#shards) {
			this.#hasBboxIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_BBOX_TABLE))
			this.#hasPopulationIndex.set(s.schemaName, this.#shardHasTable(s.schemaName, PLACE_POPULATION_TABLE))
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

		if (outcome.length > 0) return outcome

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
			const joined = trimmed.replace(/\s+/g, "")

			if (joined !== trimmed) {
				const full = await this.findPlace({ ...query, text: joined })

				if (full.length > 0) return full
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
			const map = new Map<number, CoincidentLocality[]>()

			if (coincidentRolesExists(this.#db)) {
				const rows = this.#db
					.prepare(
						`SELECT cr.admin_id AS adminID, s.id AS id, s.name AS name, s.country AS country,
							s.latitude AS lat, s.longitude AS lon,
							cr.relationship_type AS relationshipType, cr.locality_population AS population,
							cr.distance_km AS distanceKm
						FROM ${COINCIDENT_ROLES_TABLE} cr JOIN spr s ON s.id = cr.locality_id`
					)
					.all() as unknown as Array<{
					adminID: number
					id: number
					name: string
					country: string
					lat: number
					lon: number
					relationshipType: string
					population: number
					distanceKm: number
				}>

				for (const r of rows) {
					const candidate: CoincidentLocality = {
						id: r.id,
						name: r.name,
						placetype: "locality",
						country: r.country,
						lat: r.lat,
						lon: r.lon,
						score: 0,
						relationshipType: r.relationshipType,
						population: r.population,
						distanceKm: r.distanceKm,
					}
					const list = map.get(r.adminID)

					if (list) list.push(candidate)
					else map.set(r.adminID, [candidate])
				}
			}
			this.#coincidentRolesCache = map
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
			`WOFSqlitePlaceLookup: a convention names strategy "${name}", which this build does not register ` +
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
		// Over-fetch so post-scoring + exact-match tiering have room to re-rank. SHORT queries (a 2–3-char
		// region abbreviation like "NY"/"VT") are the danger case the `exactMatchTiering` docstring flags:
		// the exact-abbrev holder's BM25 is poor (its long multilingual alt-name document tanks the score),
		// so under the normal `limit * 4` window it drops OUT of the candidate pool BEFORE tiering can
		// promote it — "NY" then resolves to a token-matching foreign region (Highland, GB) instead of New
		// York. Widen the window for short queries so the exact match is always present to be tiered.
		// (Cross-country abbrev collisions — "VT" is BOTH Vermont and Viterbo — still need a country/
		// postcode signal to disambiguate; this only rescues the window-drop class, not genuine ambiguity.
		// With a `country` hint every abbrev resolves; bare + no-context lifts 7→10/15 US states.)
		const ftsLimit = query.text.trim().length <= 3 ? Math.max(limit * 4, SHORT_QUERY_OVERFETCH) : limit * 4

		// Expand the placetype filter through the shared equivalence table (core/resolver): a
		// `locality` query must also reach `borough` / `localadmin` rows — Brooklyn-the-borough
		// (pop 2.5M) is a borough, not a locality, and a strict filter made it unreachable so the
		// fuzzy "Brooklyn Park, MN" won instead. Order-preserving: the FIRST entry stays the
		// requested placetype, which is what shard routing keys off below.
		const placetypes = expandPlacetypeFilter(normalizePlacetypes(query.placetype)) as WOFPlacetype[] | null
		const ftsQuery = sanitizeFTSQuery(query.text)

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

				for (const sh of matching) pools.push(await this.#fuzzyNameMatch(query, sh))
				const byID = new Map<PlaceCandidate["id"], PlaceCandidate>()

				for (const c of pools.flat()) {
					if (!byID.has(c.id)) byID.set(c.id, c)
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

		if (query.parentID !== undefined) {
			where.push(`(spr.parent_id = ? OR spr.id IN (SELECT id FROM ${sch}.ancestors WHERE ancestor_id = ?))`)
			params.push(query.parentID, query.parentID)
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
		//
		// #905 — do NOT reach for bm25 column weights here. Measured falsification (2026-07-02): FTS5's
		// bm25 length normalization is polluted by the row's TOTAL document size, so identical 1-token
		// `name` docs read −16.0 (empty alt_names) vs −0.43 (2.7 KB alt_names) EVEN with the alt_names
		// column weighted to zero — no weighting isolates name relevance in this schema. The famous-
		// holder guarantee lives in the population-ordered companion fetch below instead, and the
		// exact tier breaks ties by population in the post-scoring sort.
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
				spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude,
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

		// #905 companion fetch: the same MATCH, ordered by population alone. For name floods
		// ("Paris" matches thousands of gap-fill villages) the bm25-based window above cannot admit
		// the famous holder — its bm25 is length-poisoned by the row's alias bulk (measured ~15 pts,
		// vs a +4.0 boost cap), so FR Paris never even reaches post-scoring. This fetch makes the
		// prominent holders of a name pool-complete BY CONSTRUCTION; the exact-tier sort below
		// decides whether they win. Skipped without a population index (nothing to order by).
		if (shardHasPopulation) {
			const popStmt = this.#db.prepare(`
				SELECT
					spr.id AS id,
					spr.name,
					spr.placetype,
					spr.country,
					spr.parent_id,
					bm25(place_search) AS rank,
					spr.latitude AS lat,
					spr.longitude AS lon,
					spr.min_latitude, spr.max_latitude, spr.min_longitude, spr.max_longitude,
					${populationSelect}
				FROM ${sch}.place_search
				${joinClause}
				${populationJoin}
				WHERE ${where.join(" AND ")}
				ORDER BY COALESCE(${PLACE_POPULATION_TABLE}.population, 0) DESC
				LIMIT ?
			`)
			const popParams = params.slice(0, params.length - 3) // drop the two boost params + ftsLimit
			const seen = new Set(rawRows.map((r) => r.id))

			for (const row of popStmt.all(...popParams, POPULATION_FETCH_LIMIT) as unknown as RawSearchRow[]) {
				if (!seen.has(row.id)) rawRows.push(row)
			}
		}

		const queryLen = query.text.length
		const candidates = rawRows.map((row): PlaceCandidate => {
			// SQLite's bm25() returns a lower-is-better score (negative for matches). Negate so we
			// start from a higher-is-better baseline.
			let score = -row.rank

			if (placetypes && placetypes.length > 0 && placetypes.includes(row.placetype as WOFPlacetype)) {
				score += this.#weights.placetypeMatchBoost
			}

			if (!placetypes && row.placetype === "locality") {
				score += this.#weights.localityImplicitBoost
			}

			if (query.country && row.country === query.country) {
				score += this.#weights.countryMatchBoost
			}

			if (query.parentID !== undefined) {
				if (row.parent_id === query.parentID) {
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
			// The best decayed-distance term over `near` + every `bias` point (each point's term is
			// scaled by its weight; the MAX wins — a candidate near ANY hint is "nearby"). Carried
			// into the exact-tier prominence sort below when hints are present.
			let proximityTerm = 0

			if (row.lat !== null && row.lon !== null && !(row.lat === 0 && row.lon === 0)) {
				const hints: Array<{ lat: number; lon: number; weight: number }> = []

				if (query.near) hints.push({ lat: query.near.lat, lon: query.near.lon, weight: 1 })

				for (const b of query.bias ?? []) hints.push({ lat: b.lat, lon: b.lon, weight: b.weight ?? 1 })

				let scoreTerm = 0

				for (const h of hints) {
					const d = haversineKm(h.lat, h.lon, row.lat, row.lon)
					const decay = h.weight / (1 + d / this.#weights.proximityScaleKm)
					const prom = decay * this.#weights.biasBoost

					if (prom > proximityTerm) {
						proximityTerm = prom
						distanceKm = d
						scoreTerm = decay * this.#weights.proximityBoost
					}
				}
				score += scoreTerm
			}

			// Population boost: capped at `populationBoost` magnitude at `10^populationScaleLog10`
			// people. Missing population → no contribution. Never penalizes.
			let popTerm = 0

			if (row.population !== null && row.population > 0 && this.#weights.populationScaleLog10 > 0) {
				const popLog = Math.log10(1 + row.population)
				const popFraction = Math.min(1, popLog / this.#weights.populationScaleLog10)
				popTerm = this.#weights.populationBoost * popFraction
				score += popTerm
			}
			// Combined prominence for the exact-tier sort when proximity hints are present: population
			// and nearness in the SAME additive units, so the map view / the user's location can win a
			// cross-country postcode tie without a hard filter.
			const prominence = popTerm + proximityTerm

			const candidate: PlaceCandidate = {
				id: row.id,
				prominence,
				name: row.name,
				placetype: row.placetype as WOFPlacetype,
				country: row.country ?? "",
				lat: row.lat ?? 0,
				lon: row.lon ?? 0,
				parent_id: row.parent_id ?? undefined,
				score,
			}

			if (distanceKm !== undefined) candidate.distanceKm = distanceKm

			if (row.population !== null && row.population > 0) candidate.population = row.population

			// Candidate bbox — parity with the WASM lookup (resolver-wof-wasm/lookup.ts), whose
			// consumers (the demo cascade's region constraint) read it. Without this the Node
			// backend's region→bbox constraint is dead and disambiguation falls to population
			// ranking (the Springfield-IL→MO failure the #524 smoke eval caught).
			if (
				row.min_latitude != null &&
				row.max_latitude != null &&
				row.min_longitude != null &&
				row.max_longitude != null
			) {
				candidate.bbox = {
					minLat: row.min_latitude,
					maxLat: row.max_latitude,
					minLon: row.min_longitude,
					maxLon: row.max_longitude,
				}
			}

			return candidate
		})

		// Exact-match tiering: a candidate whose name OR any alias equals the query text (case-folded)
		// ranks above any partial match, with the weighted-sum score (incl. population) breaking ties
		// WITHIN a tier. See the RankingWeights.exactMatchTiering docstring for why this aligns the
		// population prior rather than overriding it. One cheap indexed lookup over the candidate ids.
		// Runs even for a SINGLE candidate so `exactMatch` is stamped consistently (parity with the
		// WASM lookup) — a sole alias hit ("New York City" → New York) must still carry the flag the
		// demo cascade / #369 re-rank read.
		if (this.#weights.exactMatchTiering && candidates.length > 0) {
			const exactIds = this.#exactMatchIds(
				sch,
				candidates.map((c) => c.id as number),
				query.text
			)

			// Stamp the tier onto every candidate (not just when the tiering sort fires) so a downstream
			// re-rank — #369's postcode-anchor country pin in `resolveTree` — can keep the country pin from
			// crossing the exact/partial boundary ("ME" → Maine, not the more-populous Missouri).
			for (const c of candidates) c.exactMatch = exactIds.has(c.id as number)

			if (exactIds.size > 0) {
				// #905: WITHIN the exact tier, population is the PRIMARY key and the weighted score
				// only breaks population ties. Exactness saturates text relevance, and the bm25
				// residue inside `score` is length-noise (see the fetch-site comment), so letting it
				// order the tier is what sent unscoped "Paris" to an Ohio township. The partial tier
				// keeps score order — text relevance still means something there. This makes the
				// exactMatchTiering docstring literal: match quality primary, prominence within.
				//
				// #912 sub-tier: a NAME-exact candidate (spr.name equals the query) outranks an
				// ALIAS-exact one ('Paris' the place beats 'Paris Township' held via alias 'Paris').
				// The place's own name is a stronger identity claim than an alias — aliases exist to
				// widen recall, not to tie primaries. ME→Maine is untouched: 'ME' name-exact-matches
				// nothing, so the alias sub-tier still decides there. Population orders within each
				// sub-tier as before.
				const norm = (v: string): string => v.toLowerCase().trim().replace(/\s+/g, " ")
				const needle = norm(query.text)
				// #936 option 3: an OFFICIAL name (preferred form in an official language of the place's
				// country, `names.official = 1`) counts as the place's own name for the sub-tier — "Åbo" is
				// Turku's name, not merely its alias. Floor-gated on the holder's population (see the
				// RankingWeights docstring for the measured 100k boundary). officialIds ⊆ exactIds by
				// construction (official rows are names rows), so only the sub-tier KIND changes.
				const officialIds = this.#weights.officialNameExact
					? this.#officialNameIds(
							sch,
							candidates
								.filter(
									(c) => exactIds.has(c.id as number) && (c.population ?? 0) >= this.#weights.officialNameExactFloor
								)
								.map((c) => c.id as number),
							query.text
						)
					: undefined
				const kind = (c: PlaceCandidate): number => {
					if (!exactIds.has(c.id as number)) return 0

					if (norm(String(c.name ?? "")) === needle) return 2

					return officialIds?.has(c.id as number) ? 2 : 1
				}
				// With proximity hints (near/bias), prominence (population + nearness, same units)
				// replaces raw population as the within-tier key — the 48026 rule: the map view or
				// the user's location breaks a cross-country postcode tie. Without hints, population
				// ordering is byte-identical to before.
				const hasHints = !!query.near || (query.bias?.length ?? 0) > 0
				candidates.sort((a, b) => {
					const ax = kind(a)
					const bx = kind(b)

					if (bx !== ax) return bx - ax

					if (ax >= 1) {
						if (hasHints) return (b.prominence ?? 0) - (a.prominence ?? 0) || b.score - a.score

						return (b.population ?? 0) - (a.population ?? 0) || b.score - a.score
					}

					return b.score - a.score
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

			if (cid !== null) chain.push(cid)
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
		let id: number | null = null

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

				if (bag) bag.push(a.postalCity)
				else postalAliasByGeo.set(key, [a.postalCity])
			}
		}

		const merged = new Map<number, PlaceCandidate>()

		for (const c of ftsCands) merged.set(c.id as number, c)
		const missing = [...pcInfo.keys()].filter((id) => !merged.has(id))

		for (const row of this.#fetchLocalitiesByID(missing)) merged.set(row.id, row)

		const scored: Array<PlaceCandidate & { exact: boolean }> = []

		for (const cand of merged.values()) {
			const info = pcInfo.get(cand.id as number)
			const sPc = info ? (info.containing ? 1 : Math.exp(-info.dist / CF_PC_DECAY_KM)) : 0
			// Fold any postal-city aliases for this candidate's geographic name into the soft name match
			// (#475). `postalAliasByGeo` is empty unless the opt-in reader was supplied, so when off this
			// reduces to the original `info?.aliases ?? []` and the score is unchanged.
			const wofAliases = info?.aliases ?? []
			const aliases =
				postalAliasByGeo.size > 0
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
	#fetchLocalitiesByID(ids: number[]): PlaceCandidate[] {
		if (ids.length === 0) return []
		const hasPop = this.#hasPopulationIndex.get("main") === true
		const popSelect = hasPop ? `pp.population AS population` : `NULL AS population`
		const popJoin = hasPop ? `LEFT JOIN main.${PLACE_POPULATION_TABLE} pp ON pp.id = s.id` : ""
		const ph = ids.map(() => "?").join(", ")
		const rows = this.#db
			.prepare(
				`SELECT s.id AS id, s.name AS name, s.country AS country, s.parent_id AS parent_id,
				        s.latitude AS lat, s.longitude AS lon, s.placetype AS placetype, ${popSelect}
				 FROM main.spr s ${popJoin}
				 WHERE s.id IN (${ph}) AND s.is_current != 0`
			)
			.all(...ids) as unknown as Array<RawSearchRow>

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

			if (row.population !== null && row.population > 0) c.population = row.population

			return c
		})
	}

	/**
	 * Among `ids`, return the subset whose name OR any alias equals `text` case-insensitively — the exact-match tier for
	 * ranking. One indexed query over `<schema>.names`. When the shard has no `names` table (a slim DB built with
	 * `dropNames`, or a postcode-only shard), fall back to the self-contained `place_search` FTS content: its `alt_names`
	 * column is the same alias set joined on the boundary-preserving `ALIAS_SEPARATOR` (#523), so `aliasBagExactMatch`
	 * recovers the exact alias tier ("New York City" → New York) that the dropped `names` table used to provide.
	 */
	#exactMatchIds(schemaName: string, ids: number[], text: string): Set<number> {
		const out = new Set<number>()
		const trimmed = text.trim()

		if (ids.length === 0 || !trimmed) return out
		const placeholders = ids.map(() => "?").join(", ")

		try {
			const rows = this.#db
				.prepare(
					`SELECT DISTINCT id FROM ${schemaName}.names WHERE id IN (${placeholders}) AND name = ? COLLATE NOCASE`
				)
				.all(...ids, trimmed) as Array<{ id: number }>

			for (const r of rows) out.add(r.id)

			return out
		} catch {
			// No `names` table on this shard — fall through to the place_search alias bag.
		}

		try {
			const rows = this.#db
				.prepare(
					`SELECT wof_id AS id, name, alt_names FROM ${schemaName}.place_search WHERE wof_id IN (${placeholders})`
				)
				.all(...ids) as Array<{ id: number; name: string | null; alt_names: string | null }>
			const norm = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ")
			const needle = norm(trimmed)

			for (const r of rows) {
				if (r.name !== null && norm(r.name) === needle) out.add(r.id)
			}
			// Alias pass via the shared bag parser (#523). Separated bags (built since #523) get a true
			// per-alias equality check, ungated — matching the `names`-table branch above, where an
			// alias match counts as exact regardless of other candidates. Legacy bags (no separator)
			// fall back to padded containment, gated on "no canonical exact in the pool" because their
			// lost boundaries would otherwise false-promote interior fragments ("York" inside the alias
			// "New York City") or cross-alias fragments ("York New" across "…York" + "New City…").
			const anyCanonicalExact = out.size > 0

			for (const r of rows) {
				if (aliasBagExactMatch(r.alt_names, needle, anyCanonicalExact)) out.add(r.id)
			}
		} catch {
			// Shard without place_search either → no exact-match tier. Falls back to weighted-sum order.
		}

		return out
	}

	/**
	 * Among `ids` (already known exact matches), the subset holding `text` as an OFFICIAL name (`names.official = 1`, the
	 * #940 ingest bit). Same COLLATE NOCASE semantics as {@link WOFSqlitePlaceLookup.#exactMatchIds} so the two probes
	 * agree on what "equals the query" means. Fails soft on gazetteers built before #940 (no `official` column) — the
	 * sub-tier then behaves exactly as if `officialNameExact` were off.
	 */
	#officialNameIds(schemaName: string, ids: number[], text: string): Set<number> {
		const out = new Set<number>()
		const trimmed = text.trim()

		if (ids.length === 0 || !trimmed) return out
		const placeholders = ids.map(() => "?").join(", ")

		try {
			const rows = this.#db
				.prepare(
					`SELECT DISTINCT id FROM ${schemaName}.names WHERE id IN (${placeholders}) AND official = 1 AND name = ? COLLATE NOCASE`
				)
				.all(...ids, trimmed) as Array<{ id: number }>

			for (const r of rows) out.add(r.id)
		} catch {
			// Pre-#940 gazetteer (no `official` column) or a names-less slim shard — feature inert.
		}

		return out
	}

	close(): void {
		// Destroying the Kysely instance closes the underlying connection IF we own it. If the caller
		// passed in a pre-opened DatabaseSync (test fixture), respect their ownership.
		void this.#kysely.destroy()

		if (this.#ownsDB) {
			this.#db.close()
		}
	}

	[Symbol.dispose](): void {
		this.close()
	}

	/** Build the FTS5 virtual table from the `names` + `places` tables. */
	#ensureFTS(): void {
		buildPlaceSearchFTS(this.#db)
	}

	#assertFTSExists(): void {
		if (!placeSearchFTSExists(this.#db)) {
			throw new Error(
				"WOFSqlitePlaceLookup: `place_search` FTS5 table is missing. Pass `buildFTS: true` to build it on open, or run `mailwoman-wof-build-fts <path-to-wof.db>` ahead of time (see resolver-wof-sqlite/README.md)."
			)
		}
	}
}

function normalizePlacetypes(p: FindPlaceQuery["placetype"]): WOFPlacetype[] | null {
	if (!p) return null

	return Array.isArray(p) ? p : [p]
}

/**
 * Make an arbitrary user-typed string safe for FTS5 MATCH.
 *
 * FTS5 has its own query syntax (`"phrase"`, `term1 OR term2`, `prefix*`, NEAR/N, etc.). Letting raw user input through
 * means a user typing `Paris's` or `St. (Petersburg)` causes a syntax error.
 *
 * Per-token rules:
 *
 * - Strip all punctuation except trailing `*` from each whitespace-separated token.
 * - **Trailing `*`** is preserved as FTS5 **prefix syntax** — `627*` becomes the literal `627*` (unquoted). The caller
 *   signaled they want a prefix; respect that.
 * - All other tokens are wrapped in `"..."` as a single-word phrase. Conservative — handles apostrophes, parens, accented
 *   input, etc. safely.
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
function sanitizeFTSQuery(text: string): string {
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
