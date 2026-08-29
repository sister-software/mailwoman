/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-side {@link PlaceLookup} over the byte-range CANDIDATE table (`build-candidate.ts`) — the
 *   SAME gazetteer the browser demo resolves against ({@link WOFCandidateTableLookup} in
 *   `docs/src/shared/httpvfs-resolver.ts`), but reading a LOCAL `candidate.db` via `node:sqlite`
 *   instead of sql.js-httpvfs. This is what makes the server/CLI resolver match the demo: one
 *   lookup surface, one artifact, one ranking.
 *
 *   The query is a single contiguous probe on the `WITHOUT ROWID` B-tree keyed `(name_key,
 *   country_id, region_id, placetype_id, neg_rank, spr_id)`. `name_key` is the SHARED
 *   {@link normalizeLocalityForKey} (build- and query-consistent), each row is denormalized (display
 *   `name`, centroid, bbox), and population rank is precomputed into `neg_rank` — so the result is
 *   POPULATION-FIRST and COUNTRY-AGNOSTIC (when no `country` filter is given), exactly like the
 *   demo. That's the deliberate divergence from {@link WOFSQLitePlaceLookup}'s FTS/bm25 ranking: a
 *   bare "Moscow" resolves to the 10.4 M-pop Russian city, not whichever same-name US township bm25
 *   floats to the top.
 *
 *   Disambiguation rides the same mechanism the cascade already uses: a parsed region resolves to its
 *   stored bbox and the locality query is point-in-bbox-filtered on the candidate centroid (the
 *   `bbox` field on {@link FindPlaceQuery}).
 */

import { jaroWinkler, levenshteinSimilarity } from "@mailwoman/match/comparators"
import {
	expandPlacetypeFilter,
	partitionByContainment,
	type Ancestor,
	type GazetteerArtifactCoverage,
} from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import {
	CANDIDATE_ANCESTOR_TABLE,
	CANDIDATE_INTERVAL_TABLE,
	intervalContains,
	type CandidateAncestorTable,
	type IntervalLabel,
} from "./candidate-ancestors-schema.ts"
import { CANDIDATE_FTS_TABLE } from "./candidate-fts.ts"
import type { CandidateDatabase, CandidateTable, CountryCodeTable, PlacetypeCodeTable } from "./candidate-schema.ts"
import { readGazetteerCoverageManifest } from "./coverage-manifest-schema.ts"
import { referentialFromPopulation } from "./place-importance-schema.ts"
import { POSTAL_CITY_CANDIDATE_TABLE, type PostalCityCandidateTable } from "./postal-city-candidate-schema.ts"
import { rankByPrimaryPreference, type RankedRow, RERANK_FETCH } from "./primary-preference.ts"
import { applyProximityRerank } from "./proximity-rerank.ts"
import { REGION_CLASS_PLACETYPES, regionQualifierProbeKeys } from "./region-keys.ts"
import { allRows, hasColumn, hasTable } from "./sqlite-utils.ts"
import { type NameKey, normalizeLocalityForKey, stripLocalityQualifier } from "./street-normalize.ts"
import type { FindPlaceQuery, PlaceCandidate, PlaceLookup, WOFPlacetype } from "./types.ts"

export { rankByPrimaryPreference } from "./primary-preference.ts"
export type { RankedRow } from "./primary-preference.ts"

export interface WOFCandidateTableLookupOpts {
	/**
	 * Path to a `candidate.db` built by `build-candidate.ts`. Opened read-only.
	 */
	databasePath?: string
	/**
	 * Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`.
	 */
	database?: DatabaseClient<CandidateDatabase>
	/**
	 * #1882 opt-in: exempt `name_role = 'variant'` aliases — the holder's own primary name in another orthography,
	 * stamped by the build's own-name detector — from the cross-country primary-preference penalty. No-ops on an artifact
	 * without the role column. Default OFF (D-rule).
	 */
	variantAliasExemption?: boolean
}

/**
 * The candidate columns this lookup probes — a typed projection of the SHARED {@link CandidateTable}, so a column rename
 * in `build-candidate` (the writer) is a compile error here (the reader).
 */
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
	// `importance` is OPTIONAL on the row rather than `number | null`, because whether the SELECT names it
	// depends on the artifact: a candidate.db built before #28 has no such column and the probe leaves it
	// out (see `#importanceSelect`). `undefined` therefore means "this build cannot tell you", which is the
	// same answer as `null`'s "the score source had no measurement" — both are UNMEASURED, and the emit
	// below collapses them into the one thing the consumer understands: no `importance` field at all.
	Partial<Pick<CandidateTable, "importance">>

/**
 * FTS5-trigram over-fetch before the WORD-LEVEL re-rank. The trigram index stays the candidate GENERATOR (it is what
 * the artifact carries); the scoring moved off trigram-Jaccard on 2026-08-12 (#1614), which the aucklnad receipts
 * falsified as a typo measure: it scored the true transposition correction 'auckland' at 0.333 — below its own 0.34 bar
 * — while 'auckley' scored 0.375 and the 'gore bay' scrape 0.455, because shared generic suffixes count as trigram
 * evidence and transpositions count against it.
 */
const FUZZY_FETCH = 40

/**
 * Minimum WORD-LEVEL similarity (max of Jaro-Winkler and normalized edit similarity — the `match/comparators`
 * primitives, deliberately WITHOUT `nameSimilarity`'s token-subset floor, which is a person-name rule that would hand
 * 'stanmore bay' to a place named 'Bay') for a fuzzy correction to count. Measured on the #1614 receipts:
 * 'aucklnad'→'auckland' 0.975 (in), →'auckley' 0.868 (in, but outranked), 'stanmore bay'→'gore bay' ~0.70 (out),
 * 'sacremento'→'sacramento' ~0.97 (in).
 */
const WORD_FUZZY_MIN = 0.85

/**
 * The word-level correction similarity — see {@link WORD_FUZZY_MIN}.
 */
function wordFuzzySimilarity(a: string, b: string): number {
	return Math.max(jaroWinkler(a, b), levenshteinSimilarity(a, b))
}

/**
 * Postcode-containment re-rank gate radius (km) — the SAME value the resolver's country pass measures at
 * (`POSTCODE_COUNTRY_COHERENCE_GATE_KM`, resolver/postcode-country-coherence.ts): a locality within this distance of
 * the postcode's own centroid counts as "containing" it. One number, two passes — a divergence here would make the two
 * mechanisms disagree about what is proximal.
 */
const POSTCODE_CONTAINMENT_GATE_KM = 25

/**
 * Unpadded character-trigrams of `s`, OR'd into an FTS5 trigram MATCH query (each quoted so FTS treats it as a literal
 * term). Returns "" when `s` is shorter than a trigram or yields no clean grams — the caller then skips the fuzzy
 * probe.
 */
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
 * Node {@link PlaceLookup} over `candidate.db`. Drop-in for {@link WOFSQLitePlaceLookup} in `createWOFResolver(backend)`
 * — same `findPlace` contract, population-first ranking.
 */
export class WOFCandidateTableLookup implements PlaceLookup, Disposable {
	#db: DatabaseClient<CandidateDatabase>
	/**
	 * Resources this instance opened. A connection handed in by a caller is NOT in here, so disposal cannot reach it —
	 * ownership is membership rather than a flag a later branch has to check.
	 */
	readonly #resources = new DisposableStack()
	readonly #countryToID = new Map<string, number>()
	readonly #idToCountry = new Map<number, string>()
	readonly #placetypeToID = new Map<string, number>()
	readonly #idToPlacetype = new Map<number, string>()
	/**
	 * Prepared `(name_key, postcode)` probe for the #741 postal-city side-index — `undefined` when the
	 * `postal_city_candidate` table isn't present, so a candidate.db built without it is byte-stable.
	 */
	readonly #postalCityProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	/**
	 * Prepared FTS5-trigram MATCH probe for the typo-tolerant fallback — `undefined` when the `candidate_fts` index isn't
	 * present, so a candidate.db built without it is byte-stable (the fuzzy path is skipped, exactly like today).
	 */
	readonly #ftsProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	/**
	 * Prepared UNFILTERED existence probe (`name_key` present anywhere, ignoring country/placetype/bbox). Gates the fuzzy
	 * fallback: fuzzy is a TYPO corrector, so it engages only when the name doesn't exist in the gazetteer at all. A name
	 * that DOES exist but missed under the active filter is a filter miss (e.g. a placer misroute "Vienna, Austria"→IT),
	 * not a spelling miss — fuzzing it would scrape an unrelated same-country place and defeat the cascade's
	 * country-agnostic retry. Prepared only alongside `#ftsProbe`.
	 */
	readonly #nameKeyExistsProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	/**
	 * Facts this candidate DB declares about itself — the coverage manifest (`country_coverage` + `country_bbox`) the
	 * gazetteer build emits, read once at open. `undefined` when the artifact predates the manifest, so every consumer
	 * (the hard-country coverage gate, guard-B plausibility) falls back to its code constants byte-identically.
	 */
	readonly artifactCoverage: GazetteerArtifactCoverage | undefined
	/**
	 * `", importance"` when this artifact carries the #28 fame column, `""` when it does not — spliced into the probe's
	 * SELECT list. Existence-gated exactly like `#ftsProbe` and `#postalCityProbe` above, and for the same reason: a
	 * candidate.db built before the column is a valid artifact, and naming a column it lacks would turn a stale gazetteer
	 * into `no such column` on the first keystroke rather than into "no fame signal", which is what it is.
	 */
	readonly #importanceSelect: string
	/**
	 * Whether the artifact carries the #1730 `name_role` column — absent on pre-role builds, where the `excludeNameRoles`
	 * filter degrades to a no-op rather than erroring on a missing column.
	 */
	readonly #hasNameRole: boolean
	readonly #variantAliasExemption: boolean
	/**
	 * `", name_role"` when the artifact carries the column — the probe SELECT rides it so the #1882 exemption can read
	 * the stamp off the row; empty on a pre-role build.
	 */
	readonly #roleSelect: string
	/**
	 * Prepared chain probe over the `candidate_ancestor` sidecar — `undefined` when the artifact predates it.
	 */
	readonly #ancestorsProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	readonly #ancestorsCache = new Map<number, Ancestor[]>()
	/**
	 * Prepared interval-label probe over `candidate_interval` — `undefined` when the artifact predates the sidecar, which
	 * is what makes the admin-containment re-rank (#1717 stage 2) capability-gated: without it,
	 * `FindPlaceQuery.regionQualifier` is ignored, no candidate carries a `containedByQualifier` stamp, and the resolver
	 * walk reports the lever `unavailable` instead of silently dead.
	 */
	readonly #intervalProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	readonly #intervalCache = new Map<number, IntervalLabel | null>()
	/**
	 * Prepared qualifier probe: the region-band rows (plus `country` — the region SLOT can hold a mislabeled country
	 * name, "Moscow, Russia" parses region="Russia") for one folded qualifier key. `undefined` when the artifact lacks
	 * the sidecar or the placetype dictionary lacks the band entirely.
	 */
	readonly #qualifierProbe: ReturnType<DatabaseClient["prepare"]> | undefined
	/**
	 * The ancestor lineage of a resolved place — nearest-first (locality-tier → county → region → … → country), the same
	 * order the FTS backend's `ancestorLineage` serves, read from the `candidate_ancestor` sidecar in one clustered
	 * probe. Backs `ResolveOpts.includeAncestors` (#404) on this backend, which is what puts region-class ancestry in
	 * front of the admin-coherence check (#1717).
	 *
	 * A PROPERTY, not a method, and assigned only when the artifact carries the sidecar: capability probes (`typeof
	 * backend.ancestors === "function"` — the resolver's gap report) then read the ARTIFACT truthfully. A candidate.db
	 * built before the sidecar reports the capability absent instead of presenting a method that answers `[]` for every
	 * place, which would be an absence dressed as a negative answer.
	 */
	readonly ancestors: ((id: number | string) => Ancestor[]) | undefined

	constructor(opts: WOFCandidateTableLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
		} else if (opts.databasePath) {
			this.#db = this.#resources.use(new DatabaseClient<CandidateDatabase>(opts.databasePath, { readOnly: true }))
		} else {
			throw new Error("WOFCandidateTableLookup needs `databasePath` or `database`")
		}

		// The code tables are tiny (country/placetype dictionaries) — load them once at construction so
		// `findPlace` is a single B-tree probe with no dictionary round-trip.
		for (const r of allRows<CountryCodeTable>(this.#db.prepare("SELECT id, code FROM country_codes"))) {
			const code = String(r.code).toUpperCase()
			this.#countryToID.set(code, Number(r.id))
			this.#idToCountry.set(Number(r.id), code)
		}

		for (const r of allRows<PlacetypeCodeTable>(this.#db.prepare("SELECT id, placetype FROM placetype_codes"))) {
			this.#placetypeToID.set(String(r.placetype), Number(r.id))
			this.#idToPlacetype.set(Number(r.id), String(r.placetype))
		}

		// #741 postal-city side-index: prepare the exact probe only if the table is present. Absent →
		// `#postalCityProbe` stays undefined → findPlace skips the postal-city path → byte-stable.
		if (hasTable(this.#db, POSTAL_CITY_CANDIDATE_TABLE)) {
			this.#postalCityProbe = this.#db.prepare(
				`SELECT spr_id, name, latitude, longitude FROM ${POSTAL_CITY_CANDIDATE_TABLE} WHERE name_key = ? AND postcode = ? LIMIT 1`
			)
		}

		// FTS5-trigram fuzzy fallback: prepare the MATCH probe only if the index is present (the unified
		// gazetteer carries it; an older candidate.db doesn't → the fuzzy path is skipped, byte-stable).
		if (hasTable(this.#db, CANDIDATE_FTS_TABLE)) {
			this.#ftsProbe = this.#db.prepare(
				`SELECT name_key FROM ${CANDIDATE_FTS_TABLE} WHERE ${CANDIDATE_FTS_TABLE} MATCH ? ORDER BY bm25(${CANDIDATE_FTS_TABLE}) LIMIT ?`
			)

			this.#nameKeyExistsProbe = this.#db.prepare("SELECT 1 FROM candidate WHERE name_key = ? LIMIT 1")
		}

		// #28 fame column: probed ONCE here (it runs a PRAGMA, and `findPlace` is per-keystroke hot).
		this.#importanceSelect = hasColumn(this.#db, "candidate", "importance") ? ", importance" : ""
		this.#hasNameRole = hasColumn(this.#db, "candidate", "name_role")
		this.#variantAliasExemption = opts.variantAliasExemption === true
		this.#roleSelect = this.#hasNameRole ? ", name_role" : ""

		// Ancestors sidecar (#1717): existence-gated like the probes above, and the CAPABILITY gates with
		// it — see the `ancestors` property doc for why an older artifact must read as "no ancestors()"
		// rather than as a method that answers [] everywhere.
		if (hasTable(this.#db, CANDIDATE_ANCESTOR_TABLE)) {
			this.#ancestorsProbe = this.#db.prepare(
				`SELECT parent_spr_id, parent_placetype_id, parent_name FROM ${CANDIDATE_ANCESTOR_TABLE}` +
					" WHERE spr_id = ? ORDER BY depth ASC"
			)

			this.ancestors = (id) => this.#ancestorLineage(id)
		}

		// Admin-containment re-rank (#1717 stage 2): gated on the interval half of the sidecar (built in
		// the same pass as the closure rows; probed separately so a hand-degraded artifact degrades
		// truthfully) AND on the placetype dictionary carrying the qualifier band at all.
		if (this.#ancestorsProbe && hasTable(this.#db, CANDIDATE_INTERVAL_TABLE)) {
			this.#intervalProbe = this.#db.prepare(`SELECT pre, post FROM ${CANDIDATE_INTERVAL_TABLE} WHERE spr_id = ?`)

			const bandIDs = [...REGION_CLASS_PLACETYPES, "country"]
				.map((placetype) => this.#placetypeToID.get(placetype))
				.filter((id): id is number => id !== undefined)

			if (bandIDs.length) {
				this.#qualifierProbe = this.#db.prepare(
					`SELECT DISTINCT spr_id FROM candidate WHERE name_key = ? AND placetype_id IN (${bandIDs.join(",")}) LIMIT 8`
				)
			}
		}

		// Coverage manifest (survey candidate #2): the artifact's own coverage facts, existence-gated like
		// the probes above — a candidate.db built before the manifest reads `undefined` and consumers keep
		// their code-constant fallbacks byte-identically.
		this.artifactCoverage = readGazetteerCoverageManifest(this.#db)
	}

	/**
	 * The memoized chain read behind {@link ancestors}. Sync raw `.prepare()` on purpose — the backend contract's
	 * `ancestors()` is synchronous (the sync-by-interface resolver-reader rule), and the sidecar row already carries the
	 * parent's name and placetype, so this is one clustered probe with no join.
	 */
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

	/**
	 * The interval label for one place, memoized. `null` is a real answer — the place has no recorded ancestry in the
	 * source (absence semantics: UNVERIFIABLE, never a containment verdict) — and is cached as such.
	 */
	#intervalLabel(sprID: number): IntervalLabel | null {
		if (!this.#intervalProbe) return null

		const cached = this.#intervalCache.get(sprID)

		if (cached !== undefined) return cached

		const row = this.#intervalProbe.get(sprID) as { pre: number; post: number } | undefined
		const label = row ? { pre: Number(row.pre), post: Number(row.post) } : null

		this.#intervalCache.set(sprID, label)

		return label
	}

	/**
	 * The qualifier's own rows in the candidate table: every region-band (+ country) place whose `name_key` matches one
	 * of the qualifier's {@link regionQualifierProbeKeys} expansions. Alias keys participate — `Thüringen` finds the row
	 * stored as `Thuringia` through the artifact's own alias keying, which is precisely the variant-form bridge the
	 * admin-coherence verdicts' fold-equality bound cannot offer (its stated v1 bound). Empty = the qualifier names
	 * nothing the artifact knows; the caller then stamps `false` everywhere and reorders nothing.
	 */
	#qualifierRegionIDs(qualifier: string, country: string | undefined): Set<number> {
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
	 * Is `sprID` contained by ANY of the qualifier's rows? Interval first — {@link intervalContains}, O(1), reflexive —
	 * then the closure rows where intervals abstain: the interval forest encodes only the CANONICAL parent per place, so
	 * a `false` there means "not contained along the canonical hierarchy", and the chain probe (one clustered read of
	 * ≤{@link MAX_ANCESTOR_DEPTH} rows) is the complete record that determines the result.
	 */
	#containedByQualifier(sprID: number, qualifierIDs: ReadonlySet<number>, qualifierLabels: IntervalLabel[]): boolean {
		if (qualifierIDs.has(sprID)) return true

		const label = this.#intervalLabel(sprID)

		if (label && qualifierLabels.some((outer) => intervalContains(outer, label))) return true

		return this.#ancestorLineage(sprID).some((ancestor) => qualifierIDs.has(Number(ancestor.id)))
	}

	/**
	 * The #1717 stage-2 re-rank over one lookup's final row set. Three steps, each additive:
	 *
	 * 1. Resolve the qualifier to its region-band rows ({@link #qualifierRegionIDs}) and stamp every existing row's
	 *    `containedByQualifier` — the stamp is the trace surface, written even when nothing reorders.
	 * 2. INJECT contained same-key candidates the country scope hid: the deciding-site measurement (2026-08-18, the #1729
	 *    lesson re-confirmed) showed `Weimar, Thüringen` under the en-US locale probes `country_id = US`, so the DE row
	 *    is not IN the list and no reorder of the list can reach it. The injection probe runs the same exact fold (and,
	 *    on a contained-miss, the qualifier-strip variant restricted to primary keys — the #1626 alias-scrape guard)
	 *    under the SHAPE conds only, appends contained rows not already present, and never removes anything — recall can
	 *    only widen. The typo-fuzzy tier is deliberately not probed: a qualifier cannot vouch for a name the gazetteer
	 *    does not carry.
	 * 3. Partition contained-first — the SHARED {@link partitionByContainment} (tier-safe, stable; the resolver walk runs
	 *    the same function after its fame re-rank, one function at both deciding sites per the #861 rule) — then
	 *    re-window to `limit`.
	 *
	 * A qualifier that matches nothing stamps `false` everywhere and reorders nothing — byte-identical answers, and the
	 * walk's verdict reads `no_contained_candidate` rather than `unavailable` (the question WAS asked).
	 */
	#applyAdminContainment(
		rows: Array<RankedRow<CandidateRow>>,
		qualifier: string,
		country: string | undefined,
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
				this.#db.prepare(injectSQL(primaryOnly)),
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

		// #1731: the dependent-locality band. A locality query's filter group (locality/borough/localadmin)
		// cannot reach a neighbourhood-tier namesake, so a CONTAINED one is structurally invisible no matter
		// how the list reorders — the Astoria class: Queens' Astoria is a WOF neighbourhood, and the walk
		// answered the Oregon locality under `qualifier="NY"` because nothing in the pool sat under NY. The
		// widening is injection-only and triple-gated: the band is explicit (neighbourhood/macrohood/microhood
		// — never region or country tiers), admission still requires the sidecar's containment proof, and only
		// primary-keyed rows enter (an alias-keyed neighbourhood is the #1626 scrape class). Recall can only
		// widen, and only toward rows the qualifier vouches for. `opts.shapeFilters`' bbox clause is
		// deliberately not carried: containment is the stronger constraint, and the two co-occurring is not a
		// measured shape.
		const bandIDs = ["neighbourhood", "macrohood", "microhood"]
			.map((placetype) => this.#placetypeToID.get(placetype))
			.filter((id): id is number => id !== undefined)

		if (bandIDs.length) {
			const bandSQL =
				"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank, is_primary, population" +
				`${this.#importanceSelect} FROM candidate WHERE name_key = ? AND placetype_id IN (${bandIDs.map(() => "?").join(",")}) AND is_primary = 1 ` +
				"ORDER BY neg_rank ASC LIMIT ?"

			const fetched = allRows<CandidateRow>(this.#db.prepare(bandSQL), opts.nameKey, ...bandIDs, RERANK_FETCH)

			for (const row of fetched) {
				const sprID = Number(row.spr_id)

				if (present.has(sprID) || !contained(sprID)) continue
				present.add(sprID)

				injected.push({ ...row, effectiveNegRank: row.neg_rank, demoted: false, containedByQualifier: true })
			}
		}

		// The strip variant mirrors the cascade's discipline: tried only when the exact fold vouched for
		// nothing, and primary-keyed only (a stripped surface never named an alias — #1626).
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

	/**
	 * Does this query want a locality-tier place? Postal-city aliases (#741) are all localities.
	 */
	#wantsLocality(placetype: FindPlaceQuery["placetype"]): boolean {
		if (!placetype) return true
		const want = Array.isArray(placetype) ? placetype : [placetype]

		return expandPlacetypeFilter(want as readonly string[]).includes("locality")
	}

	/**
	 * The postcode-containment anchor: the postcode's own centroid row in the candidate table, keyed whitespace-stripped
	 * (#920 — the same fold the build applies to postcode rows), country-scoped when the query is, first
	 * coordinate-bearing row wins. null when the candidate table carries no such postcode — the re-rank then abstains,
	 * because a recall gap is not evidence for the name match. Meaning-of-zero: a 0,0 row is the build's unlocated
	 * sentinel, never a real centroid.
	 */
	#postcodeAnchor(postcode: string, country?: string): { lat: number; lon: number } | null {
		const placetypeID = this.#placetypeToID.get("postalcode")

		if (placetypeID === undefined) return null

		const conds = ["name_key = ?", "placetype_id = ?"]
		const params: Array<string | number> = [postcode.replaceAll(/\s+/g, ""), placetypeID]

		if (country) {
			const countryID = this.#countryToID.get(country.toUpperCase())

			if (countryID === undefined) return null // a country the candidate table doesn't carry
			conds.push("country_id = ?")
			params.push(countryID)
		}

		const row = this.#db
			.prepare(`SELECT latitude, longitude FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT 1`)
			.get(...params) as { latitude: number; longitude: number } | undefined

		if (!row || (Number(row.latitude) === 0 && Number(row.longitude) === 0)) return null

		return { lat: Number(row.latitude), lon: Number(row.longitude) }
	}

	async findPlace(query: FindPlaceQuery): Promise<PlaceCandidate[]> {
		let text = (query.text ?? "").trim()

		if (!text) return []

		// #920 name law, candidate-key edition: postcode rows are keyed by their whitespace-stripped
		// form at build (the GeoNames fold normalizes '624 66' → '62466'), so a postcode-typed query
		// strips internal whitespace before keying. Postcode-only — locality names keep their spaces.
		const wantsPostcode = [query.placetype].flat().includes("postalcode")

		if (wantsPostcode) {
			text = text.replaceAll(/\s+/g, "")
		}

		const nameKey = normalizeLocalityForKey(text)

		if (!nameKey) return []

		// #741: postcode-keyed postal-city alias. An exact `(name_key, postcode)` hit resolves a
		// user-typed POSTAL city ("Antioch", 37013) to the geographic locality the postcode sits in
		// ("Nashville"), bypassing the population/region ranking that can't see the postcode. Gated on
		// the side-index being present, a postcode in the query, and a locality-tier request — so the
		// common (no-postcode / non-locality) path is untouched. A hit short-circuits: the postcode is
		// an exact, high-confidence disambiguator, so we return the single geographic locality.
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
						score: 1,
						exactMatch: true,
					},
				]
			}
		}

		const limit = Math.max(1, query.limit ?? 10)

		// Filter conds shared by the exact-key + strip-fallback probes (everything but name_key). The
		// SHAPE subset (placetype/bbox/primary — everything but the country scope) is kept separately
		// because the admin-containment injection probe (#1717 stage 2) runs under the shape conds
		// WITHOUT the country: bypassing a locale-inferred country scope for a qualifier-vouched
		// candidate is the lever's whole point, and it is the one filter injection may cross.
		const filters: string[] = []
		const filterParams: Array<string | number> = []
		const shapeFilters: string[] = []
		const shapeParams: Array<string | number> = []

		if (query.country) {
			const cid = this.#countryToID.get(query.country.toUpperCase())

			if (cid === undefined) return [] // a country the candidate table doesn't carry
			filters.push("country_id = ?")
			filterParams.push(cid)
		}

		if (query.placetype) {
			// Shared placetype-equivalence expansion (a `locality` query must also reach borough /
			// localadmin). `postalcode` maps to no admin placetype here → empty → no rows.
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

		// The re-reading guard (#1632, the #1626 rationale generalized to the caller): a probe whose surface
		// is a token cut out of a longer classified span never NAMED an alias, so alias-keyed rows must not
		// answer it — 'Savile Row''s token 'Row' resolved Rhu, Scotland (585 km) through the village's
		// historical-name alias key. Whole-input bare probes never set this, keeping the exonym recall the
		// #1546 note protects (Москва's alias rows answer 'Moscow').
		if (query.primaryOnly) {
			shapeFilters.push("is_primary = 1")
		}

		// The role guard (#1730): a probe may refuse abbreviation/gloss alias rows while keeping the
		// role-NULL exonym tier open — the distinction `primaryOnly` cannot express. Degrades to a no-op
		// on an artifact without the column.
		if (query.excludeNameRoles?.length && this.#hasNameRole) {
			shapeFilters.push(`(name_role IS NULL OR name_role NOT IN (${query.excludeNameRoles.map(() => "?").join(",")}))`)
			shapeParams.push(...query.excludeNameRoles)
		}

		// The main-probe conds are country-then-shape, exactly the order they have always been.
		filters.push(...shapeFilters)
		filterParams.push(...shapeParams)

		// Region scope: when the cascade resolves a region and passes it down as `parentID` (the walk sets
		// `query.parentID = parentResolved.id`), the candidate build stamps each place's region-tier ancestor
		// id into `region_id` (build-candidate.ts `regionOf`), and that id equals the resolved region's WOF id
		// — so `region_id = parentID` scopes the probe to in-region rows. Without it a bare same-name probe is
		// population-first and "Springfield, IL" (parentID = Illinois) drops to the larger Springfield, MO.
		// Kept OUT of the shared `filters` so a region MISS falls back to the unscoped cascade below: a
		// country/non-region parent (no `region_id` match), a `region_id=0` row (place with no region
		// ancestor), or a wrong parent degrades to today's behavior — never worse, recall-safe by construction.
		const regionParentID = query.parentID || undefined

		const probe = (nk: string, regionID: number | undefined, countryID?: number): Array<RankedRow<CandidateRow>> => {
			const conds = ["name_key = ?", ...filters]
			const params: Array<string | number> = [nk, ...filterParams]

			if (regionID !== undefined) {
				conds.push("region_id = ?")
				params.push(regionID)
			}

			// #1585: the fuzzy tier's country scope — only the corrected-key probes pass this.
			if (typeof countryID === "number") {
				conds.push("country_id = ?")
				params.push(countryID)
			}

			// Fetch population-ordered (the clustered-key order — a cheap ordered scan), over-fetching to
			// RERANK_FETCH so the bounded cross-country primary-preference re-rank (below) can promote the
			// intended primary even when a cluster of more-populous foreign aliases sits ahead of it. `is_primary`
			// + `country_id` feed that re-rank. A single-country probe (a country filter, or all rows same
			// country) re-ranks to the identical population order, so the common path is untouched.
			// `population` rides along for the REFERENTIAL score on the result (ROAD_TO_V9 §2) — one more
			// column off a clustered row the probe already reads, and it is NOT what the probe orders by:
			// `neg_rank` remains the sort key, so this changes no ordering, only what the result reports.
			// `importance` (#28) rides along on the same terms, and there is deliberately NO `ORDER BY` on it:
			// the fame prior is applied by the RESOLVER (`resolver/toponym-prior.ts`), which alone knows
			// whether the query was bare enough to deserve it. A backend that pre-sorted by fame would apply
			// it to every lookup, including the qualified addresses the D-rule guard exists to protect.
			const sql =
				"SELECT spr_id, name, country_id, placetype_id, latitude, longitude, min_lat, min_lon, max_lat, max_lon, neg_rank, is_primary, population" +
				`${this.#importanceSelect}${this.#roleSelect} FROM candidate WHERE ${conds.join(" AND ")} ORDER BY neg_rank ASC LIMIT ?`

			const fetched = allRows<CandidateRow>(this.#db.prepare(sql), ...params, Math.max(limit, RERANK_FETCH))

			return rankByPrimaryPreference(fetched, limit, undefined, this.#idToPlacetype, this.#variantAliasExemption)
		}

		// The exact → qualifier-strip → typo-fuzzy probe cascade, run at a fixed region scope. Region scoping
		// only tightens an already-population-first pick, so a region MISS re-runs the whole cascade unscoped
		// (below) rather than dropping a place that has no in-region row.
		const cascade = (regionID: number | undefined): Array<RankedRow<CandidateRow>> => {
			let rows = probe(nameKey, regionID)

			if (!rows.length) {
				// Query-side qualifier-strip fallback: an OA locality with a qualifier the gazetteer's
				// canonical name omits ("Lenk im Simmental" → "Lenk", "Roche VD"). Tried ONLY on an exact
				// miss; the cascade's region bbox disambiguates any base-name ambiguity.
				const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(text))

				if (strippedKey && strippedKey !== nameKey) {
					// #1626: a stripped probe may answer only through a NON-PRIMARY alias key, which is a
					// scrape, not a qualifier match — 'Savile Row' stripped to 'row' resolved Rhu, Scotland
					// (585 km) through the village's historical-name alias. The legitimate qualifier class
					// matches the place's own primary key ('Lenk im Simmental' → the Lenk row keyed 'lenk',
					// is_primary=1), so refusing alias-keyed rows keeps every intended case and kills the
					// scrape. The alias tier remains fully available to EXACT queries — only the stripped
					// RETRY loses it, because the query's own surface never named the alias.
					rows = probe(strippedKey, regionID).filter((r) => r.is_primary === 1)
				}
			}

			// Typo-tolerant fallback (the unified gazetteer's fuzzy mode): an exact + strip miss may be a
			// misspelling the normalized key can't reach. FTS5-trigram fetches a loose set; we re-rank by
			// trigram-Jaccard (the admin backend's measure) and probe the best name_keys, so a typo resolves
			// the same on either backend. The country/placetype/bbox/region filters still apply via `probe`.
			// Skipped when the index is absent (byte-stable for an older candidate.db).
			//
			// Gate: only when the name doesn't exist in the gazetteer AT ALL (unfiltered). A name that exists
			// but missed under the active country/placetype/bbox filter is a FILTER miss, not a spelling miss
			// — fuzzing it scrapes an unrelated same-filter place ("Vienna, Austria" misrouted to IT would
			// pull a tiny Italian name_key near Siena) and masks the cascade's country-agnostic retry that
			// correctly lands population-first Vienna AT. The exact/strip probes already covered the real name.
			//
			// NEVER for postcodes: fuzzy is a typo corrector for place NAMES, and a "corrected" postcode is a
			// DIFFERENT postcode. The 2026-08-05 Code-Point swap exposed the trap at scale: Northern Ireland's
			// `BT3 9QQ` (absent — no permissive NI source) trigram-matched Sheffield's `S3 9QQ` (Jaccard 0.4
			// on {39q, 9qq}) and resolved 200+ km wrong with full confidence. An unknown postcode must abstain.
			// #1585: a locale HINT scopes the typo tier to its country. Only when no hard `country`
			// filter is active (that is already narrower); a scope naming a country the table doesn't
			// carry is a SCOPED-EMPTY — the fuzzy tier abstains rather than falling through worldwide.
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
						// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
						.sort((a, b) => b.s - a.s)

					const seen = new Set<string>()

					for (const h of ranked) {
						if (seen.has(h.nk)) continue
						seen.add(h.nk)
						// #17: stamp the tier. These rows answer a name the gazetteer does not carry, so they are
						// fuzzy matches and `exactMatch` below must say so — see `RankedRow.fuzzy`.
						rows.push(...probe(h.nk, regionID, fuzzyCountryID).map((r) => ({ ...r, fuzzy: true })))

						if (rows.length >= limit) break
					}

					rows = rows.slice(0, limit)
				}
			}

			return rows
		}

		let rows = cascade(regionParentID)
		// #1731: whether the rows the caller receives came from the UNSCOPED fallback below — the backend's
		// interior gate the resolver-side trace (#1721) cannot otherwise see. Stamped onto every returned
		// place, because the re-admission path is exactly where a wrong-instance namesake enters.
		let regionScopeMiss = false

		// Region-scope fallback: if scoping to the parent region found nothing across the whole cascade, retry
		// unscoped so a place with no in-region row (missing ancestry, or a country/non-region parent) still
		// resolves exactly as it does today. Only when a region scope was actually applied.
		if (!rows.length && regionParentID !== undefined) {
			rows = cascade(undefined)
			regionScopeMiss = rows.length > 0
		}

		// Postcode-containment coherence (#31, Mechanism 2): re-rank the rows by proximity to the postcode's
		// own centroid, so the locality that CONTAINS the postcode wins the name-match tie (the "Paris" that
		// holds 75001, not the one that holds a 75001-free namesake). The resolver sends this flag on locality
		// lookups when `ResolveOpts.postcodeContainmentCoherence` is on. Strictly beneath the #741 postal-city
		// short-circuit above — an exact (name, postcode) hit IS the answer and outranks any re-rank — and after
		// the region-scope fallback, so it sees the final row set. Rows within the gate sort by distance first;
		// the out-gate tail keeps its original population-first order. No in-gate row, or no postcode row in
		// the candidate table → unchanged (byte-identical to the flag-off path).
		if (
			query.postcode &&
			query.postcodeContainmentCoherence === true &&
			this.#wantsLocality(query.placetype) &&
			rows.length > 1
		) {
			const anchor = this.#postcodeAnchor(query.postcode, query.country)

			if (anchor) {
				const inGate: Array<{ row: RankedRow<CandidateRow>; distanceKm: number }> = []
				const outGate: RankedRow<CandidateRow>[] = []

				for (const row of rows) {
					const distanceKm = haversineKm(anchor.lat, anchor.lon, Number(row.latitude), Number(row.longitude))

					if (distanceKm <= POSTCODE_CONTAINMENT_GATE_KM) {
						inGate.push({ row, distanceKm })
					} else {
						outGate.push(row)
					}
				}

				if (inGate.length) {
					// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
					inGate.sort((a, b) => a.distanceKm - b.distanceKm)
					rows = [...inGate.map(({ row }) => row), ...outGate]
				}
			}
		}

		// Admin-containment re-rank (#1717 stage 2): LAST, on the final row set — the qualifier is the
		// address's outermost explicit statement, so its partition outranks the postcode-proximity order
		// above (contained rows keep that order among themselves). Capability-gated on the sidecar
		// (`#qualifierProbe`); when the artifact predates it, `regionQualifier` is ignored, no stamp is
		// written, and the resolver walk reports the lever `unavailable`.
		if (query.regionQualifier?.trim() && this.#qualifierProbe && this.#wantsLocality(query.placetype)) {
			rows = this.#applyAdminContainment(rows, query.regionQualifier.trim(), query.country, {
				nameKey,
				strippedKey: normalizeLocalityForKey(stripLocalityQualifier(text)),
				shapeFilters,
				shapeParams,
				limit,
			})
		}

		const candidates = rows.map((row): PlaceCandidate => {
			const hasBbox = row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null

			return {
				id: Number(row.spr_id),
				name: String(row.name ?? ""),
				placetype: (this.#idToPlacetype.get(Number(row.placetype_id)) ?? "") as WOFPlacetype,
				// Surfaced so the cascade can country-gate a postcode by the resolved locality (an ambiguous
				// international postcode like 10115 = Berlin DE AND New York US must not out-resolve the city).
				country: this.#idToCountry.get(Number(row.country_id)) ?? "",
				lat: Number(row.latitude),
				lon: Number(row.longitude),
				// `score` stays the RAW population rank (`-neg_rank`) — it feeds the resolver walk's absolute
				// `minWinningScore` gate (`resolve.ts`), which must see real prominence, never a penalized value.
				score: -Number(row.neg_rank),
				// `prominence` carries the bounded cross-country primary preference (the effective, penalty-adjusted
				// rank). The walk ORDERS candidates by `prominence ?? score` (`resolve.ts`), so this is what makes the
				// re-rank actually stick through resolution — without it the walk re-sorts by raw `score` and a
				// more-populous foreign alias (Changchun for "Cancun") wins back the node. Equals `score` for every
				// un-penalized row (primaries + same-country aliases), so the common ordering is unchanged.
				prominence: -Number(row.effectiveNegRank),
				// Every candidate row IS an exact normalized-name (or alias/abbrev) match — the cascade's exact tier
				// accepts alias-exact hits ("New York City" → New York) the same as canonical — EXCEPT a cross-country
				// alias that lost the bounded contest to a same-key primary (`demoted`): it drops to the partial tier so
				// the walk's country posterior can't cross back over the primary (see `RankedRow.demoted`) — and
				// EXCEPT a row the typo-corrector produced (`fuzzy`), which by definition answers a name the
				// gazetteer does not carry (see `RankedRow.fuzzy`).
				exactMatch: !row.demoted && !row.fuzzy,
				// #1731: emitted ONLY when a region scope was applied, missed, and the unscoped fallback
				// produced this row — the re-admission path. Absence means the question never arose.
				...(regionScopeMiss ? { regionScopeMiss: true } : {}),
				// #1717 stage 2 — the containment stamp, tri-state: emitted ONLY when the question was
				// asked (a `regionQualifier` query over a sidecar-bearing artifact); its absence is what
				// the resolver walk reports as `unavailable` (meaning-of-zero).
				...(row.containedByQualifier === undefined ? {} : { containedByQualifier: row.containedByQualifier }),
				// #1893 — the exemption's firing mark, carried only when the ranker actually spared this row
				// the cross-country penalty (see RankedRow.variantExempted).
				...(row.variantExempted ? { variantAliasExempted: true as const } : {}),
				// The two-score split's carry (ROAD_TO_V9 §2). `referential` names the prominence this
				// backend has always ordered by — `neg_rank` IS `-log10(population + 1)`, so the score and
				// the sort key are two readings of the same number.
				...(row.population === null || row.population <= 0
					? {}
					: { population: row.population, referential: referentialFromPopulation(row.population) }),
				// #28: the fame prior, from the `importance` column the candidate build joins in. Emitted ONLY
				// when the artifact measured this place — an absent field is what `rankByImportance` reads as
				// "does not participate", and a 0 would be a claim nobody made (meaning-of-zero).
				//
				// The field name matches the column because they hold the same thing: the score source's
				// BLENDED prior — the concordance's encyclopedia-derived channel where a concordance matched, a
				// population-derived proxy everywhere else. It is NOT the strict `encyclopedic` channel
				// `place-importance-schema.ts` defines, and it deliberately does not land in that field: the
				// strict channel was measured on 2026-08-10 and covers eleven countries, none of them CA/AU/RU,
				// which makes it inert on three of the four homonym contests the prior exists to settle.
				// `PlaceCandidate.encyclopedic` stays reserved for a strict-channel source (the FTS backend's
				// clauses are strict and today emit NULL for everything — no shipped admin DB has the split
				// table at all). See `candidate-schema.ts` → {@link CandidateTable.importance}.
				...(typeof row.importance === "number" && Number.isFinite(row.importance)
					? { importance: row.importance }
					: {}),
				...(hasBbox
					? {
							bbox: {
								minLat: Number(row.min_lat),
								maxLat: Number(row.max_lat),
								minLon: Number(row.min_lon),
								maxLon: Number(row.max_lon),
							},
						}
					: {}),
			}
		})

		// Proximity re-rank (#938) — the shared implementation, so the browser byte-range twin runs the same
		// code rather than the same constants. See proximity-rerank.ts for why that distinction mattered.
		if (query.bias && query.bias.length) {
			applyProximityRerank(candidates, query.bias)
		}

		return candidates
	}

	close(): void {
		this.#resources.dispose()
	}

	[Symbol.dispose](): void {
		this.close()
	}
}
