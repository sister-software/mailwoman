/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The five data sources behind `mwdev_lookup` that are not the FST: the candidate gazetteer, the WOF admin shards,
 *   `poi.db`, the codex reference tables, and the postcode-anchor artifact the model is fed. `lookup.ts` owns the
 *   contract these all answer under; this file owns the probes.
 *
 *   **Every one of them keys on something other than the string a human types**, and that is the whole reason this tool
 *   exists rather than a `SELECT … WHERE name = ?`:
 *
 *   - `candidate.db` and `poi.db` key on `name_key` — {@link normalizeLocalityForKey}, applied at BUILD and at query
 *     time. Probing `name` instead reports three places as missing from the gazetteer that are all present:
 *     `Porto Petro` is stored under `porto petro`, `Illes Balears` under `illes balears` (whose stored `name` is
 *     "Balearic Islands"), `St. Margaret's Hope` under `st margarets hope`.
 *   - the WOF shards answer through an FTS5 index over `name` AND `alt_names`, so a hit may be an alias or a postcode
 *     row's parent locality — and that index is BUILT with the `is_current`/`is_deprecated` filter already applied, so
 *     seeing a deprecated record at all takes a second route.
 *   - the postcode anchor keys `span.replace(" ", "").toUpperCase()`, the train painter's normalization, so `SW1A 2AA`
 *     is `SW1A2AA`.
 *
 *   Each probe therefore reports the KEY it used next to the value it found, so the difference between them is visible
 *   instead of being the silent cause of a wrong "absent".
 */

import type { DatabaseSync } from "node:sqlite"

import { candidateSystemsForPostcode, us } from "@mailwoman/codex"
import { allRows, getRow } from "@mailwoman/core/utils"
import type { AnchorSpanMode } from "@mailwoman/neural/anchor-inference"
import { sanitizeFTSQuery } from "@mailwoman/resolver-wof-sqlite/fts-query"
import { normalizeLocalityForKey, stripLocalityQualifier } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import type { LookupRow } from "./lookup.ts"
import { type PlaceIDProvenance, placeIDProvenance } from "./place-id-provenance.ts"

/**
 * How many rows a probe returns per query before it stops.
 *
 * PER PROBE, not per query: a source that reads several shards on several routes binds this to each one, so a set of
 * six shards on two routes can return up to twelve times this number. Every probe therefore reports `returned` beside
 * `matched` — the count the source actually holds, measured by its own COUNT rather than inferred from the list —
 * because a truncated list whose length is presented as a total reads as coverage it does not have.
 */
const DEFAULT_ENTRY_LIMIT = 10

/**
 * Which key reached a candidate row.
 *
 * The runtime cascade tries these in order and a caller who only saw `exact` would read a qualifier hit as an absence.
 * `fuzzy` is deliberately NOT here: the FTS5-trigram typo tier corrects a misspelling into a DIFFERENT string, so
 * running it would report a hit for a surface the gazetteer has never held.
 */
const CandidateRoute = {
	/**
	 * `normalizeLocalityForKey(query)` — the key the build wrote.
	 */
	Exact: "exact",
	/**
	 * The key with a locality qualifier removed ("Lenk im Simmental" → `lenk`). Primary-name rows only, matching the
	 * runtime: a stripped probe that answers through an alias is a scrape, not a qualifier match.
	 */
	QualifierStrip: "qualifier-strip",
	/**
	 * The key with internal whitespace deleted — the fold postcode rows are BUILT under, so `624 66` is stored `62466`.
	 */
	PostcodeFold: "postcode-fold",
} as const

type CandidateRoute = (typeof CandidateRoute)[keyof typeof CandidateRoute]

export interface CandidateLookupOptions {
	/**
	 * ISO alpha-2 filter. A country the artifact carries no dictionary entry for is reported as a COVERAGE gap, never as
	 * a miss on the name.
	 */
	country?: string
	limit?: number
}

interface CandidateEntry extends PlaceIDProvenance {
	route: CandidateRoute
	name_key: string
	name: string | null
	placetype: string
	country: string
	latitude: number | null
	longitude: number | null
	population: number | null
	is_primary: number | null
	importance: number | null
	/**
	 * The place id this row points at, named for WOF's `spr` table (Standard Place Response) because that is the schema
	 * it came from. It is a real WOF id only when {@link PlaceIDProvenance.wof_id} is non-null — roughly half the
	 * gazetteer is Overture- or GeoNames-minted and carries an id in a reserved synthetic range that looks identical.
	 */
	spr_id: number
}

const CANDIDATE_SELECT =
	"SELECT c.name_key, c.name, pc.placetype AS placetype, cc.code AS country, c.latitude, c.longitude, " +
	"c.population, c.is_primary, c.importance, c.spr_id FROM candidate c " +
	"JOIN placetype_codes pc ON pc.id = c.placetype_id JOIN country_codes cc ON cc.id = c.country_id " +
	"WHERE c.name_key = ?"

/**
 * Probe `candidate.db` on `name_key`, the key the build writes and the reader probes.
 *
 * Reports the matched key beside the stored `name`, because they routinely differ and the difference is the answer: a
 * hit on `illes balears` whose `name` reads "Balearic Islands" and whose `is_primary` is 0 was reached through an alias
 * row, which is a different fact from a canonical match.
 *
 * Two values in a hit are zeros that must not be read as absences, and two absences are not zeros:
 *
 * - `importance: null` is UNMEASURED — the score source had no row for that place — while `population: 0` and a `(0, 0)`
 *   centroid are the build's own written values (the latter its unlocated sentinel).
 * - A `country` naming no `country_codes` entry means the artifact carries no rows for that country at all, so the miss
 *   is a coverage gap; a country it DOES carry, with rows under the key elsewhere, is a filter miss and reports the
 *   third state (`hit`, no entries).
 */
export function lookupCandidate(
	db: DatabaseSync,
	queries: string[],
	options: CandidateLookupOptions = {}
): LookupRow[] {
	const limit = options.limit ?? DEFAULT_ENTRY_LIMIT
	const wantCountry = options.country?.toUpperCase()

	const countryID = wantCountry
		? (db.prepare("SELECT id FROM country_codes WHERE code = ?").get(wantCountry) as { id: number } | undefined)
		: undefined

	const carriedCountries = (db.prepare("SELECT count(*) AS n FROM country_codes").get() as { n: number }).n

	const countAll = db.prepare("SELECT count(*) AS n FROM candidate WHERE name_key = ?")
	const countScoped = db.prepare("SELECT count(*) AS n FROM candidate WHERE name_key = ? AND country_id = ?")
	const rowsAll = db.prepare(`${CANDIDATE_SELECT} ORDER BY c.neg_rank ASC LIMIT ?`)
	const rowsScoped = db.prepare(`${CANDIDATE_SELECT} AND c.country_id = ? ORDER BY c.neg_rank ASC LIMIT ?`)

	const probe = (key: string): { total: number; totalUnscoped: number; rows: Array<Omit<CandidateEntry, "route">> } => {
		const totalUnscoped = (countAll.get(key) as { n: number }).n

		if (!countryID) {
			return {
				total: totalUnscoped,
				totalUnscoped,
				rows: allRows<Omit<CandidateEntry, "route">>(rowsAll, key, limit),
			}
		}

		return {
			total: (countScoped.get(key, countryID.id) as { n: number }).n,
			totalUnscoped,
			rows: allRows<Omit<CandidateEntry, "route">>(rowsScoped, key, countryID.id, limit),
		}
	}

	return queries.map((query) => {
		const exactKey = normalizeLocalityForKey(query)

		if (!exactKey) {
			return {
				query,
				hit: false,
				entries: null,
				note: "Normalizes to the empty key, so there is nothing to probe. Not an answer about the gazetteer.",
			}
		}

		if (wantCountry && !countryID) {
			return {
				query,
				hit: false,
				entries: null,
				note:
					`This artifact carries no rows for country ${wantCountry} at all — its dictionary holds ` +
					`${carriedCountries} countries and that is not one of them. A COVERAGE gap, not an absence of the name.`,
			}
		}

		const notes: string[] = []

		if (exactKey !== query) {
			notes.push(
				`Probed as name_key ${JSON.stringify(exactKey)}, not the string you typed — the fold is applied at build ` +
					"AND at query time, and probing `name` instead is the miss that reads as absence."
			)
		}

		let route: CandidateRoute = CandidateRoute.Exact
		let key = exactKey
		let found = probe(exactKey)

		// The runtime's own extra keys, IN ITS ORDER. The whitespace fold comes first because `findPlace`
		// applies it at the top, before the cascade — and the order is load-bearing, not cosmetic: measured
		// against the shipped candidate.db, "1012 LG" strips to `1012` and resolves the NL PC6 unit to the
		// 4-digit stem in NL *and* DK, while its own row sits under `1012lg`. Strip-first coarsens a hit it
		// should never have reached.
		if (!found.total) {
			const fusedKey = normalizeLocalityForKey(query.replaceAll(/\s+/g, ""))

			if (fusedKey && fusedKey !== exactKey) {
				const fused = probe(fusedKey)

				if (fused.total) {
					route = CandidateRoute.PostcodeFold
					key = fusedKey
					found = fused

					notes.push(
						`Reached only through the whitespace-stripped key ${JSON.stringify(fusedKey)} — the fold postcode rows ` +
							"are BUILT under, so a spaced code misses under its own spelling."
					)
				}
			}
		}

		if (!found.total) {
			const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(query))

			if (strippedKey && strippedKey !== exactKey) {
				const stripped = probe(strippedKey)
				// #1626: primary rows only. An alias-keyed stripped hit is a scrape ('Savile Row' → 'row' → Rhu).
				const primary = stripped.rows.filter((row) => row.is_primary === 1)

				if (primary.length) {
					route = CandidateRoute.QualifierStrip
					key = strippedKey
					found = { total: primary.length, totalUnscoped: stripped.totalUnscoped, rows: primary }

					notes.push(
						`Reached only through the qualifier-strip retry on ${JSON.stringify(strippedKey)} — the runtime's ` +
							"own fallback, restricted (as there) to primary-name rows. The base name is a DIFFERENT place " +
							"from the one queried; the runtime disambiguates it downstream with a region bbox this probe has no."
					)
				}
			}
		}

		if (!found.total) {
			return {
				query,
				hit: false,
				entries: null,
				note:
					`Absent under key ${JSON.stringify(exactKey)}` +
					(wantCountry ? ` in ${wantCountry}` : "") +
					(found.totalUnscoped && wantCountry
						? ` — though the key reaches ${found.totalUnscoped} row(s) in other countries, so this is a FILTER miss.`
						: ", and under the qualifier-strip and whitespace-stripped retries. ABSENCE, not a zero.") +
					" One runtime tier is deliberately not run here: the FTS5-trigram typo corrector, which would answer" +
					" about a DIFFERENT string and report it as a hit for this one.",
			}
		}

		if (wantCountry && !found.rows.length) {
			return {
				query,
				hit: true,
				entries: [],
				note:
					`The key ${JSON.stringify(key)} exists (${found.totalUnscoped} row(s)) but none in ${wantCountry}. ` +
					"A filter miss, which is neither absence nor a zero.",
			}
		}

		const entries: CandidateEntry[] = found.rows.map((row) => ({ route, ...row, ...placeIDProvenance(row.spr_id) }))
		const unmeasured = entries.filter((entry) => entry.importance === null).length
		const unlocated = entries.filter((entry) => entry.latitude === 0 && entry.longitude === 0).length
		const top = entries[0]!

		if (top.name && normalizeLocalityForKey(top.name) !== normalizeLocalityForKey(query)) {
			notes.push(`Top row's stored name is ${JSON.stringify(top.name)}, not the surface queried.`)
		}

		if (top.is_primary === 0) {
			notes.push("Top row is is_primary=0 — an alias/abbreviation row, not the place's canonical name.")
		}

		if (unmeasured) {
			notes.push(
				`importance is NULL on ${unmeasured} of ${entries.length} row(s) shown: the score source had no ` +
					"measurement for that place. UNMEASURED, never an importance of zero."
			)
		}

		if (unlocated) {
			notes.push(
				`${unlocated} row(s) carry a (0, 0) centroid — the build's unlocated sentinel, not a coordinate off Africa.`
			)
		}

		return {
			query,
			hit: true,
			entries,
			note:
				`${found.total} row(s) under key ${JSON.stringify(key)}` +
				(wantCountry ? ` in ${wantCountry}` : "") +
				`; the ${entries.length} above are the first by neg_rank (population-first). ` +
				notes.join(" "),
		}
	})
}

/**
 * One opened WOF admin/postcode shard.
 */
export interface WOFShard {
	/**
	 * How the shard is named in output — its basename, which is how every runbook refers to it.
	 */
	name: string
	db: DatabaseSync
}

/**
 * Which index reached a WOF record.
 *
 * The two answer different questions and only together cover the shard. `fts` is what the RESOLVER can reach; the FTS5
 * content is built with `is_current != 0 AND is_deprecated = 0` applied, so a deprecated record is not merely filtered
 * at query time — it was never indexed. `names-exact` is the byte-exact probe on the indexed `names` table, which
 * carries deprecated records and is the only cheap way to see them.
 */
const WOFRoute = {
	Fts: "fts",
	NamesExact: "names-exact",
} as const

type WOFRoute = (typeof WOFRoute)[keyof typeof WOFRoute]

interface WOFEntry extends PlaceIDProvenance {
	route: WOFRoute
	shard: string
	id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	/**
	 * The containing place's id, straight off `spr.parent_id`. Emitted because a same-name pair is only readable as a
	 * DUPLICATE — a district and its seat — when the parent link is visible; without it the two rows look like two
	 * unrelated places that happen to tie.
	 */
	parent_id: number
	/**
	 * `place_population.population`, or `null` when the place has NO row there.
	 *
	 * Null is absence and 0 is a recorded zero, and the resolver reads them differently: `referentialFromPopulation`
	 * treats both as no evidence, but only one of them is a claim the source made. Emitted because population is what
	 * `neg_rank` and `referential` are computed FROM, so a ranking question cannot be answered without it.
	 */
	population: number | null
}

/**
 * One row as {@link SPR_COLUMNS} projects it: a {@link WOFEntry} minus the fields the probe adds, plus the two currency
 * flags the caller filters on and then drops.
 */
type WOFRow = Omit<WOFEntry, "route" | "shard" | keyof PlaceIDProvenance> & {
	is_current: number
	is_deprecated: number
}

const SPR_COLUMNS =
	"spr.id, spr.parent_id, spr.name, spr.placetype, spr.country, spr.latitude, spr.longitude, " +
	"spr.is_current, spr.is_deprecated, pop.population AS population"

/**
 * LEFT, not INNER: a place with no `place_population` row must still appear, carrying `population: null`. An inner join
 * would drop it and the miss would read as the shard not holding the place at all.
 */
const SPR_JOINS = "LEFT JOIN place_population pop ON pop.id = spr.id"

const WOF_FTS_FROM = `FROM place_search JOIN spr ON spr.id = place_search.wof_id ${SPR_JOINS} WHERE place_search MATCH ?`
const WOF_NAMES_FROM = `FROM names n JOIN spr ON spr.id = n.id ${SPR_JOINS} WHERE n.name = ?`

/**
 * Build the pair of statements for one route: the row SELECT and the COUNT that gives it a denominator.
 *
 * The country filter is appended to BOTH, so a scoped probe reports how many rows the key has in that country rather
 * than how many it has anywhere — the difference between a filter miss and an absence, which is the distinction this
 * whole tool exists to keep.
 */
function wofStatements(from: string, order: string, scoped: boolean): { rows: string; count: string } {
	const where = scoped ? `${from} AND spr.country = ?` : from

	return {
		rows: `SELECT ${SPR_COLUMNS} ${where}${order} LIMIT ?`,
		count: `SELECT COUNT(*) AS n ${where} AND spr.is_current != 0 AND spr.is_deprecated = 0`,
	}
}

/**
 * Probe the WOF admin + postcode shards — the source data behind the FTS backend, and behind `candidate.db`'s build.
 *
 * Read this next to `candidate`: a string the candidate table misses and this one holds is a BUILD gap, not a data gap.
 * `Sultan Qaboos` is the worked example — absent from `candidate.db`, reached here through the FTS index's `alt_names`
 * column as `مدينة السلطان قابوس` in OM.
 *
 * Two routes, because one index cannot answer both halves. The `place_search` FTS5 content is populated with
 * `is_current != 0 AND is_deprecated = 0` applied at BUILD time, so it can never show a deprecated record; the `names`
 * table can, and is indexed. Rows the resolver cannot see are counted and named but kept OUT of `entries`, so a name
 * whose every record is deprecated reports the third state — known to WOF, nothing downstream.
 *
 * The FTS route ANDs tokens over `name` and `alt_names`, so a match is not a claim that the shard stores this exact
 * string; read the returned `name`. The `names` route is byte-exact under the index's binary collation, so case and
 * punctuation matter there — which is why a double miss says what was checked rather than "WOF does not have it".
 */
export function lookupWOF(
	shards: WOFShard[],
	queries: string[],
	options: { limit?: number; country?: string } = {}
): LookupRow[] {
	const limit = options.limit ?? DEFAULT_ENTRY_LIMIT
	const country = options.country?.trim().toUpperCase()
	const scoped = Boolean(country)

	const fts = wofStatements(WOF_FTS_FROM, " ORDER BY bm25(place_search)", scoped)
	const names = wofStatements(WOF_NAMES_FROM, "", scoped)

	return queries.map((query) => {
		const match = sanitizeFTSQuery(query)
		const entries: WOFEntry[] = []
		const seen = new Set<number>()
		const suppressed: string[] = []
		const failed: string[] = []
		// Summed across shards and routes, then de-duplicated below. The same place reached by BOTH routes is one
		// record, so the raw sum overstates; `matched` reports the de-duplicated figure and `scanned` the sum.
		let scanned = 0

		const collect = (shard: WOFShard, route: WOFRoute, statements: { rows: string; count: string }, bind: string) => {
			const params = scoped ? [bind, country!] : [bind]

			let rows: WOFRow[]

			try {
				rows = allRows<WOFRow>(shard.db.prepare(statements.rows), ...params, limit)
				scanned += Number(getRow<{ n: number }>(shard.db.prepare(statements.count), ...params)?.n ?? 0)
			} catch (error) {
				failed.push(`${shard.name} (${route}): ${(error as Error).message}`)

				return
			}

			for (const row of rows) {
				const { is_current, is_deprecated, ...record } = row

				if (is_current !== 0 && is_deprecated === 0) {
					if (seen.has(record.id)) continue
					seen.add(record.id)
					entries.push({ route, shard: shard.name, ...record, ...placeIDProvenance(record.id) })
				} else {
					suppressed.push(
						`${shard.name}#${record.id} ${JSON.stringify(record.name)}` +
							` (is_current=${is_current}, is_deprecated=${is_deprecated})`
					)
				}
			}
		}

		for (const shard of shards) {
			if (match) {
				collect(shard, WOFRoute.Fts, fts, match)
			}

			collect(shard, WOFRoute.NamesExact, names, query.trim())
		}

		const shardNote = failed.length ? ` ${failed.length} probe(s) failed: ${failed.join("; ")}.` : ""
		const scopeNote = country ? ` Scoped to country ${country}: a key held only outside it reads as 0 here.` : ""

		// `scanned` counts a place once per route that reaches it, so it is an upper bound on distinct records and
		// `entries.length` is a lower one — exact when the list was not truncated. Reporting the pair beats reporting
		// either alone, which is how the previous note's returned-count came to be read as a corpus total.
		const truncated = entries.length < scanned

		const denominator = truncated
			? `Returned ${entries.length} of up to ${scanned} row-hits (a record reached by both routes is counted once ` +
				`here and once per route there); raise \`limit\` — it binds PER SHARD PER ROUTE, not per query.`
			: `Returned all ${entries.length}.`

		const checked =
			`Checked ${shards.length} shard(s) on two routes: the FTS5 index the resolver reads ` +
			(match ? `(matching ${JSON.stringify(match)}, token-AND over name + alt_names)` : "(skipped — sanitizes empty)") +
			" and a byte-exact probe on the indexed `names` table, which is case- and punctuation-sensitive."

		if (!entries.length && !suppressed.length) {
			return { query, hit: false, entries: null, note: `ABSENCE.${scopeNote} ${checked}${shardNote}` }
		}

		if (!entries.length) {
			return {
				query,
				hit: true,
				entries: [],
				note:
					`${suppressed.length} record(s) exist and EVERY one is deprecated or not current. The FTS5 content the ` +
					"resolver queries is built with that filter already applied, so it receives NOTHING from this surface " +
					`— known to WOF, invisible downstream, and different from absence. Suppressed: ${suppressed.join("; ")}. ` +
					`${checked}${shardNote}${scopeNote}`,
			}
		}

		return {
			query,
			hit: true,
			entries,
			note:
				`${denominator}` +
				(suppressed.length
					? ` Plus ${suppressed.length} deprecated/not-current and therefore unindexed (${suppressed.join("; ")}).`
					: "") +
				`${scopeNote} ${checked}${shardNote}`,
		}
	})
}

export interface POILookupOptions {
	country?: string
	limit?: number
}

interface POIEntry {
	name: string | null
	name_key: string
	category: string | null
	country: string
	latitude: number
	longitude: number
	confidence: number
	brand_wikidata: string | null
	gers_id: string | null
}

const POI_SELECT =
	"SELECT p.name, p.name_key, cc.category AS category, p.country, p.latitude, p.longitude, p.confidence, " +
	"p.brand_wikidata, p.gers_id FROM poi p LEFT JOIN poi_category_codes cc ON cc.id = p.category_id " +
	"WHERE p.name_key = ?"

/**
 * Probe `poi.db` on `name_key` — the same {@link normalizeLocalityForKey} fold the POI build writes.
 *
 * The count is exact and unbounded. Measured on the 13.68 M-row shipped `poi.db`: `mcdonalds` (19,340 rows) counts in
 * 1.3 ms warm and 3,158 ms on the FIRST probe against a cold page cache — worth knowing before reading a slow first
 * call as a hang, and not worth trading the true denominator for.
 */
export function lookupPOI(db: DatabaseSync, queries: string[], options: POILookupOptions = {}): LookupRow[] {
	const limit = options.limit ?? DEFAULT_ENTRY_LIMIT
	const wantCountry = options.country?.toUpperCase()
	const countAll = db.prepare("SELECT count(*) AS n FROM poi WHERE name_key = ?")
	const countScoped = db.prepare("SELECT count(*) AS n FROM poi WHERE name_key = ? AND country = ?")
	const rowsAll = db.prepare(`${POI_SELECT} ORDER BY p.neg_rank ASC LIMIT ?`)
	const rowsScoped = db.prepare(`${POI_SELECT} AND p.country = ? ORDER BY p.neg_rank ASC LIMIT ?`)

	return queries.map((query) => {
		const key = normalizeLocalityForKey(query)

		if (!key) {
			return {
				query,
				hit: false,
				entries: null,
				note: "Normalizes to the empty key, so there is nothing to probe. Not an answer about poi.db.",
			}
		}

		const totalUnscoped = (countAll.get(key) as { n: number }).n

		if (!totalUnscoped) {
			return {
				query,
				hit: false,
				entries: null,
				note:
					`No POI is keyed ${JSON.stringify(key)}. ABSENCE. This probe is the exact-key path only; the runtime ` +
					"also has an FTS5 name path that can reach a row through a different tokenization.",
			}
		}

		if (wantCountry && !(countScoped.get(key, wantCountry) as { n: number }).n) {
			return {
				query,
				hit: true,
				entries: [],
				note:
					`The key ${JSON.stringify(key)} exists (${totalUnscoped} row(s)) but none in ${wantCountry}. ` +
					"A filter miss, which is neither absence nor a zero.",
			}
		}

		const total = wantCountry ? (countScoped.get(key, wantCountry) as { n: number }).n : totalUnscoped

		const entries = wantCountry
			? allRows<POIEntry>(rowsScoped, key, wantCountry, limit)
			: allRows<POIEntry>(rowsAll, key, limit)

		return {
			query,
			hit: true,
			entries,
			note:
				`${total} POI row(s) under key ${JSON.stringify(key)}` +
				(wantCountry ? ` in ${wantCountry}` : "") +
				`; the ${entries.length} above are the first by neg_rank.` +
				(key === query ? "" : ` Probed as ${JSON.stringify(key)}, not the string you typed.`),
		}
	})
}

/**
 * One codex fact about a string. `table` names WHICH reference table answered, because "the codex knows this" is four
 * unrelated questions and a caller acting on the wrong one is the failure mode.
 */
interface CodexEntry {
	table: string
	[key: string]: unknown
}

/**
 * Ask every codex reference table at once: is this a postcode SHAPE, a USPS street suffix, a secondary unit designator,
 * a directional, or a US state?
 *
 * Pure — no artifact, so this source can never be unavailable. The postcode answer is a SHAPE test and says so: `68161`
 * matches the US, German AND French five-digit shapes, and the shape alone cannot split them. Membership is what
 * `candidate` and `postcode` answer.
 */
export function lookupCodex(queries: string[]): LookupRow[] {
	return queries.map((query) => {
		const trimmed = query.trim()
		const upper = trimmed.toUpperCase()
		const entries: CodexEntry[] = []
		const systems = candidateSystemsForPostcode(trimmed)

		if (systems.length) {
			entries.push({ table: "postcode_systems", systems })
		}

		const suffix = us.lookupStreetSuffix(trimmed)

		if (suffix) {
			entries.push({ table: "us_street_suffix", suffix: suffix.suffix, abbreviation: suffix.abbreviation })
		}

		const designator = us.lookupUnitDesignator(trimmed)

		if (designator) {
			entries.push({
				table: "us_unit_designator",
				designator: designator.designator,
				abbreviation: designator.abbreviation,
				requires_range: us.US_UNIT_DESIGNATOR_REQUIRES_RANGE[designator.designator],
			})
		}

		const directional = us.pluckDirectionalName(trimmed)

		if (directional) {
			entries.push({ table: "us_directional", directional })
		}

		if (us.isUSStateAbbreviation(upper)) {
			entries.push({ table: "us_state", abbreviation: upper, name: us.US_STATE_BY_ABBREVIATION[upper] })
		}

		if (!entries.length) {
			return {
				query,
				hit: false,
				entries: null,
				note:
					"No codex table recognizes this string — not a postcode shape, USPS street suffix, unit designator, " +
					"directional or US state. ABSENCE from the reference data, which says nothing about any gazetteer.",
			}
		}

		return {
			query,
			hit: true,
			entries,
			...(systems.length
				? {
						note:
							"`postcode_systems` is a SHAPE test, not gazetteer membership: a bare five-digit code matches the " +
							"US, German and French shapes alike. Ask `postcode` or `candidate` for membership.",
					}
				: {}),
		}
	})
}

/**
 * The postcode-anchor artifact's read seam — `PostcodeBinaryResolver`'s binary search, narrowed to what this probe
 * uses.
 */
export interface PostcodeAnchorResolver {
	lookup(postcode: string): Array<{ country: string; lat: number; lon: number }>
}

export interface PostcodeLookupOptions {
	/**
	 * The span mode the loaded package's model card DECLARES. Read, never assumed: `alnum-run` (the default when a card
	 * declares nothing) splits on every non-alphanumeric character, so it can never key a code written with a space.
	 */
	spanMode: AnchorSpanMode
}

/**
 * Probe the postcode→anchor artifact the classifier feeds the model — the `postcode-<cc>.bin` sibling in the resolved
 * weights package, not a gazetteer.
 *
 * The key is `span.replace(" ", "").toUpperCase()`, the train painter's normalization, which is what makes `SW1A 2AA`
 * reachable at all. Two readings this must keep apart:
 *
 * - A record whose lat and lon are both 0 is a MEASURED ZERO: the postcode is a member, the artifact holds no centroid
 *   for it, and the channel feeds a country posterior with a (0, 0) centroid. 414 of `postcode-us.bin`'s 42,317 keys
 *   are like this.
 * - Under a card declaring `alnum-run`, a key containing a space-joined pair is present in the artifact and UNREACHABLE
 *   at serve — the scan produces `SW1A` and `2AA` separately and never the joined key. The row is a hit and the note
 *   says the running model is not fed it, because those are different facts.
 */
export function lookupPostcodeAnchor(
	resolver: PostcodeAnchorResolver,
	queries: string[],
	options: PostcodeLookupOptions
): LookupRow[] {
	return queries.map((query) => {
		const key = query.replaceAll(/\s+/g, "").toUpperCase()
		// An alnum run cannot span a non-alphanumeric character, so a query carrying one can only be keyed
		// under `shaped`. This is the scan's definition, not a heuristic about postcode shapes.
		const reachableByScan = options.spanMode === "shaped" || !/[^\p{L}\p{N}]/u.test(query.trim())
		const rows = resolver.lookup(key)

		if (!rows.length) {
			return {
				query,
				hit: false,
				entries: null,
				note:
					`No record under key ${JSON.stringify(key)}. ABSENCE from this locale's anchor artifact — which is a ` +
					"claim about one weights package, not about postcodes: a US bundle holds no GB codes.",
			}
		}

		const entries = rows.map((row) => ({
			country: row.country,
			latitude: row.lat,
			longitude: row.lon,
			has_centroid: !(row.lat === 0 && row.lon === 0),
		}))

		const notes: string[] = []

		if (key !== query) {
			notes.push(`Keyed as ${JSON.stringify(key)} — space-stripped and upper-cased, the train painter's own key.`)
		}

		if (!entries.some((entry) => entry.has_centroid)) {
			notes.push(
				"Every record carries a (0, 0) centroid: MEMBERSHIP ONLY. The channel still feeds a country posterior, " +
					"and the zero centroid is a measured zero, not a missing entry."
			)
		}

		if (!reachableByScan) {
			notes.push(
				`The card declares span_mode "${options.spanMode}", whose scan splits on every non-alphanumeric character ` +
					"and can NEVER produce this key. The artifact holds the record; the running model is not fed it."
			)
		}

		return { query, hit: true, entries, ...(notes.length ? { note: notes.join(" ") } : {}) }
	})
}
