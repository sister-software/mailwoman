/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Probes the candidate, WOF, POI, codex and postcode-anchor sources for `mwdev_lookup`.
 *
 *   Each probe reports the normalized key it used, so a reader can tell a true miss from a key mismatch.
 */

import { candidateSystemsForPostcode, us } from "@mailwoman/codex"
import { stringifyJSON } from "@mailwoman/core/json"
import { allRows, getRow } from "@mailwoman/core/utils"
import type { AnchorSpanMode } from "@mailwoman/neural/anchor-inference"
import { sanitizeFTSQuery } from "@mailwoman/resolver-wof-sqlite/fts/query"
import type { PlaceImportanceDatabase } from "@mailwoman/resolver-wof-sqlite/place-importance-schema"
import { normalizeLocalityForKey, stripLocalityQualifier } from "@mailwoman/resolver-wof-sqlite/street"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import type { LookupRow } from "#lookup/index"
import { type PlaceIDProvenance, placeIDProvenance } from "#place-id-provenance"

/**
 * The default number of rows each probe returns.
 * Each probe reports the total match count separately.
 */
const DEFAULT_ENTRY_LIMIT = 10

/**
 * The key normalization that found a candidate row.
 * The probe never uses fuzzy matching.
 */
const CandidateRoute = {
	/**
	 * The key from `normalizeLocalityForKey`.
	 */
	Exact: "exact",
	/**
	 * The key after removing a locality qualifier.
	 * Only primary-name rows count on this route.
	 */
	QualifierStrip: "qualifier-strip",
	/**
	 * The key with all whitespace removed.
	 */
	PostcodeFold: "postcode-fold",
} as const

type CandidateRoute = (typeof CandidateRoute)[keyof typeof CandidateRoute]

/**
 * Options for {@link lookupCandidate}.
 */
export interface CandidateLookupOptions {
	/**
	 * An ISO alpha-2 country filter.
	 *
	 * A country missing from the artifact is reported as a coverage gap.
	 */
	country?: string
	limit?: number
	/**
	 * An importance database.
	 *
	 * When present, each entry includes its referential and encyclopedic scores.
	 */
	importance?: { db: DatabaseClient<PlaceImportanceDatabase>; artifact: string }
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
	 * The name role.
	 * It is `null` when unset and absent in older artifacts.
	 */
	name_role?: string | null
	/**
	 * The importance database's scores for this place, or `null` when it has no row.
	 */
	importance_split?: { referential: number; encyclopedic: number | null } | null
	/**
	 * The source place ID.
	 * The `wof_id` field says whether it is a WOF ID.
	 */
	spr_id: number
}

/**
 * Builds the candidate SELECT, including `name_role` only when the artifact has that column.
 */
function candidateSelect(hasNameRole: boolean): string {
	return (
		"SELECT c.name_key, c.name, pc.placetype AS placetype, cc.code AS country, c.latitude, c.longitude, " +
		`c.population, c.is_primary, c.importance${hasNameRole ? ", c.name_role" : ""}, c.spr_id FROM candidate c ` +
		"JOIN placetype_codes pc ON pc.id = c.placetype_id JOIN country_codes cc ON cc.id = c.country_id " +
		"WHERE c.name_key = ?"
	)
}

/**
 * Probes `candidate.db` with the same `name_key` normalization that the build and the reader use.
 *
 * After an exact miss, the probe retries the runtime's own fallbacks in runtime order:
 * the whitespace-stripped key first, then the qualifier-stripped key.
 * Each note tells a missing score apart from a zero score and a country gap.
 */
export function lookupCandidate<DB>(
	db: DatabaseClient<DB>,
	queries: string[],
	options: CandidateLookupOptions = {}
): LookupRow[] {
	const limit = options.limit ?? DEFAULT_ENTRY_LIMIT
	const wantCountry = options.country?.toUpperCase()

	const countryID = wantCountry
		? (db.prepare("SELECT id FROM country_codes WHERE code = ?").get(wantCountry) as { id: number } | undefined)
		: undefined

	const carriedCountries = (db.prepare("SELECT count(*) AS n FROM country_codes").get() as { n: number }).n

	const hasNameRole = (
		db.prepare("SELECT count(*) AS n FROM pragma_table_info('candidate') WHERE name = 'name_role'").get() as {
			n: number
		}
	).n

	const select = candidateSelect(hasNameRole > 0)
	const countAll = db.prepare("SELECT count(*) AS n FROM candidate WHERE name_key = ?")
	const countScoped = db.prepare("SELECT count(*) AS n FROM candidate WHERE name_key = ? AND country_id = ?")
	const rowsAll = db.prepare(`${select} ORDER BY c.neg_rank ASC LIMIT ?`)
	const rowsScoped = db.prepare(`${select} AND c.country_id = ? ORDER BY c.neg_rank ASC LIMIT ?`)

	// The split-score statement is null when no importance database was given
	// or its schema has no `referential` column.
	// Entries then omit `importance_split`.
	const splitProbe = (() => {
		if (!options.importance) return null

		const hasSplit = (
			options.importance.db
				.prepare("SELECT count(*) AS n FROM pragma_table_info('place_importance') WHERE name = 'referential'")
				.get() as { n: number }
		).n

		if (!hasSplit) return null

		return options.importance.db.prepare("SELECT referential, encyclopedic FROM place_importance WHERE id = ?")
	})()

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
				`Probed as name_key ${stringifyJSON(exactKey)}, not the string you typed — the fold is applied at build ` +
					"AND at query time, and probing `name` instead is the miss that reads as absence."
			)
		}

		let route: CandidateRoute = CandidateRoute.Exact
		let key = exactKey
		let found = probe(exactKey)

		// `findPlace` tries the whitespace fold before the qualifier strip, and the order matters.
		// Stripping first would turn "1012 LG" into `1012` and match a coarser postcode stem,
		// while the exact row is keyed `1012lg`.
		if (!found.total) {
			const fusedKey = normalizeLocalityForKey(query.replaceAll(/\s+/g, ""))

			if (fusedKey && fusedKey !== exactKey) {
				const fused = probe(fusedKey)

				if (fused.total) {
					route = CandidateRoute.PostcodeFold
					key = fusedKey
					found = fused

					notes.push(
						`Reached only through the whitespace-stripped key ${stringifyJSON(fusedKey)} — the fold postcode rows ` +
							"are BUILT under, so a spaced code misses under its own spelling."
					)
				}
			}
		}

		if (!found.total) {
			const strippedKey = normalizeLocalityForKey(stripLocalityQualifier(query))

			if (strippedKey && strippedKey !== exactKey) {
				const stripped = probe(strippedKey)
				// Only primary-name rows count.
				// An alias match after stripping is spurious, as when 'Savile Row' strips
				// to 'row' and matches an alias of Rhu.
				const primary = stripped.rows.filter((row) => row.is_primary === 1)

				if (primary.length) {
					route = CandidateRoute.QualifierStrip
					key = strippedKey
					found = { total: primary.length, totalUnscoped: stripped.totalUnscoped, rows: primary }

					notes.push(
						`Reached only through the qualifier-strip retry on ${stringifyJSON(strippedKey)} — the runtime's ` +
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
					`Absent under key ${stringifyJSON(exactKey)}` +
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
					`The key ${stringifyJSON(key)} exists (${found.totalUnscoped} row(s)) but none in ${wantCountry}. ` +
					"A filter miss, which is neither absence nor a zero.",
			}
		}

		const entries: CandidateEntry[] = found.rows.map((row) => ({
			route,
			...row,
			...placeIDProvenance(row.spr_id),
			...(splitProbe
				? {
						importance_split: (() => {
							const split = splitProbe.get(row.spr_id) as
								| { referential: number; encyclopedic: number | null }
								| undefined

							return split ? { referential: split.referential, encyclopedic: split.encyclopedic } : null
						})(),
					}
				: {}),
		}))

		const unmeasured = entries.filter((entry) => entry.importance === null).length
		const unlocated = entries.filter((entry) => entry.latitude === 0 && entry.longitude === 0).length
		const top = entries[0]!

		if (top.name && normalizeLocalityForKey(top.name) !== normalizeLocalityForKey(query)) {
			notes.push(`Top row's stored name is ${stringifyJSON(top.name)}, not the surface queried.`)
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
				`${found.total} row(s) under key ${stringifyJSON(key)}` +
				(wantCountry ? ` in ${wantCountry}` : "") +
				`; the ${entries.length} above are the first by neg_rank (population-first). ` +
				notes.join(" "),
		}
	})
}

/**
 * The ranking fields that {@link diffCandidateRows} compares on a row present in both artifacts.
 */
const CANDIDATE_DELTA_FIELDS = ["importance", "population", "is_primary", "name_role"] as const

/**
 * The difference between two artifacts' candidate rows for one query.
 */
export interface CandidateDelta {
	query: string
	/**
	 * The rows only artifact A returned.
	 * `only_in_b` holds the reverse.
	 *
	 * Rows match on `(spr_id, name)`.
	 * A rebuilt artifact can assign new IDs to Overture places, so the same name on
	 * both sides is usually one place under a new ID.
	 */
	only_in_a: Array<{ spr_id: number; name: string | null; country: string; placetype: string }>
	only_in_b: Array<{ spr_id: number; name: string | null; country: string; placetype: string }>
	/**
	 * The rows in both artifacts whose ranking fields changed.
	 * `fields` maps each changed column to `[a, b]`.
	 */
	changed: Array<{ spr_id: number; name: string | null; country: string; fields: Record<string, [unknown, unknown]> }>
}

/**
 * Diffs two artifacts' answers to the same queries, aligned by query index.
 *
 * The diff covers only the returned rows.
 * Both sides stop at the caller's limit, so a key with many rows needs a higher limit.
 */
export function diffCandidateRows(rowsA: LookupRow[], rowsB: LookupRow[]): CandidateDelta[] {
	return rowsA.map((rowA, index) => {
		const rowB = rowsB[index]
		const entriesA = (rowA.entries ?? []) as CandidateEntry[]
		const entriesB = (rowB?.entries ?? []) as CandidateEntry[]
		const identity = (entry: CandidateEntry): string => `${entry.spr_id}\0${entry.name ?? ""}`
		const byIDA = new Map(entriesA.map((entry) => [identity(entry), entry]))
		const byIDB = new Map(entriesB.map((entry) => [identity(entry), entry]))

		const summarize = (
			entry: CandidateEntry
		): { spr_id: number; name: string | null; country: string; placetype: string } => ({
			spr_id: entry.spr_id,
			name: entry.name,
			country: entry.country,
			placetype: entry.placetype,
		})

		const changed: CandidateDelta["changed"] = []

		for (const [id, entryA] of byIDA) {
			const entryB = byIDB.get(id)

			if (!entryB) continue

			const fields: Record<string, [unknown, unknown]> = {}

			for (const field of CANDIDATE_DELTA_FIELDS) {
				const a = entryA[field] ?? null
				const b = entryB[field] ?? null

				if (a !== b) {
					fields[field] = [a, b]
				}
			}

			if (Object.keys(fields).length) {
				changed.push({ spr_id: entryA.spr_id, name: entryA.name, country: entryA.country, fields })
			}
		}

		return {
			query: rowA.query,
			only_in_a: entriesA.filter((entry) => !byIDB.has(identity(entry))).map(summarize),
			only_in_b: entriesB.filter((entry) => !byIDA.has(identity(entry))).map(summarize),
			changed,
		}
	})
}

/**
 * One open WOF admin or postcode extract.
 */
export interface WOFExtract<DB> {
	/**
	 * The extract's basename, used in output.
	 */
	name: string
	db: DatabaseClient<DB>
}

/**
 * The index that reached a WOF record.
 *
 * `fts` is the FTS5 index the resolver reads.
 * It was built without deprecated or non-current records.
 *
 * `names-exact` is a byte-exact probe on the `names` table, which still holds those records.
 */
const WOFRoute = {
	Fts: "fts",
	NamesExact: "names-exact",
} as const

type WOFRoute = (typeof WOFRoute)[keyof typeof WOFRoute]

interface WOFEntry extends PlaceIDProvenance {
	route: WOFRoute
	extract: string
	id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	/**
	 * The containing place's ID from `spr.parent_id`.
	 *
	 * The parent link shows when two same-name rows are a district and its seat.
	 */
	parent_id: number
	/**
	 * The value of `place_population.population`, or `null` when the place has no row there.
	 *
	 * `null` means the source recorded nothing, and `0` is a recorded zero.
	 * Ranking uses population to compute `neg_rank` and `referential`.
	 */
	population: number | null
}

/**
 * One row as {@link SPR_COLUMNS} selects it: a {@link WOFEntry} without the fields
 * the probe adds, plus the two currency flags the probe filters on.
 */
type WOFRow = Omit<WOFEntry, "route" | "extract" | keyof PlaceIDProvenance> & {
	is_current: number
	is_deprecated: number
}

const SPR_COLUMNS =
	"spr.id, spr.parent_id, spr.name, spr.placetype, spr.country, spr.latitude, spr.longitude, " +
	"spr.is_current, spr.is_deprecated, pop.population AS population"

/**
 * A left join, so a place without a `place_population` row still appears with `population: null`.
 */
const SPR_JOINS = "LEFT JOIN place_population pop ON pop.id = spr.id"

const WOF_FTS_FROM = `FROM place_search JOIN spr ON spr.id = place_search.wof_id ${SPR_JOINS} WHERE place_search MATCH ?`
const WOF_NAMES_FROM = `FROM names n JOIN spr ON spr.id = n.id ${SPR_JOINS} WHERE n.name = ?`

/**
 * Builds the row select and the matching count for one route.
 *
 * Both statements carry the country filter, so a scoped count covers only that country.
 * The count includes only current, non-deprecated records.
 */
function wofStatements(from: string, order: string, scoped: boolean): { rows: string; count: string } {
	const where = scoped ? `${from} AND spr.country = ?` : from

	return {
		rows: `SELECT ${SPR_COLUMNS} ${where}${order} LIMIT ?`,
		count: `SELECT COUNT(*) AS n ${where} AND spr.is_current != 0 AND spr.is_deprecated = 0`,
	}
}

/**
 * Probes the WOF admin and postcode extracts, which feed both the FTS backend and the `candidate.db` build.
 *
 * A string that these extracts hold and `candidate` misses points to a build gap.
 *
 * The probe uses two routes.
 * The FTS route matches every token across `name` and `alt_names`,
 * so the returned `name` can differ from the query.
 *
 * The `names` route is byte-exact, so case and punctuation matter there.
 *
 * Deprecated and non-current records are listed in the note and left out of `entries`.
 * A name whose records are all deprecated therefore returns a hit with no entries.
 */
export function lookupWOF<DB>(
	extracts: WOFExtract<DB>[],
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
		// The count summed over extracts and routes.
		// A place reached by both routes counts twice here.
		let scanned = 0

		const collect = (
			extract: WOFExtract<DB>,
			route: WOFRoute,
			statements: { rows: string; count: string },
			bind: string
		) => {
			const params = scoped ? [bind, country!] : [bind]

			let rows: WOFRow[]

			try {
				rows = allRows<WOFRow>(extract.db.prepare(statements.rows), ...params, limit)
				scanned += Number(getRow<{ n: number }>(extract.db.prepare(statements.count), ...params)?.n ?? 0)
			} catch (error) {
				failed.push(`${extract.name} (${route}): ${(error as Error).message}`)

				return
			}

			for (const row of rows) {
				const { is_current, is_deprecated, ...record } = row

				if (is_current !== 0 && is_deprecated === 0) {
					if (seen.has(record.id)) continue
					seen.add(record.id)
					entries.push({ route, extract: extract.name, ...record, ...placeIDProvenance(record.id) })
				} else {
					suppressed.push(
						`${extract.name}#${record.id} ${stringifyJSON(record.name)}` +
							` (is_current=${is_current}, is_deprecated=${is_deprecated})`
					)
				}
			}
		}

		for (const extract of extracts) {
			if (match) {
				collect(extract, WOFRoute.Fts, fts, match)
			}

			collect(extract, WOFRoute.NamesExact, names, query.trim())
		}

		const extractNote = failed.length ? ` ${failed.length} probe(s) failed: ${failed.join("; ")}.` : ""
		const scopeNote = country ? ` Scoped to country ${country}: a key held only outside it reads as 0 here.` : ""

		// `scanned` is an upper bound on distinct records, and `entries.length` is a lower bound.
		// The note reports both.
		const truncated = entries.length < scanned

		const denominator = truncated
			? `Returned ${entries.length} of up to ${scanned} row-hits (a record reached by both routes is counted once ` +
				`here and once per route there); raise \`limit\` — it binds PER EXTRACT PER ROUTE, not per query.`
			: `Returned all ${entries.length}.`

		const checked =
			`Checked ${extracts.length} extract(s) on two routes: the FTS5 index the resolver reads ` +
			(match ? `(matching ${stringifyJSON(match)}, token-AND over name + alt_names)` : "(skipped — sanitizes empty)") +
			" and a byte-exact probe on the indexed `names` table, which is case- and punctuation-sensitive."

		if (!entries.length && !suppressed.length) {
			return { query, hit: false, entries: null, note: `ABSENCE.${scopeNote} ${checked}${extractNote}` }
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
					`${checked}${extractNote}${scopeNote}`,
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
				`${scopeNote} ${checked}${extractNote}`,
		}
	})
}

/**
 * Options for {@link lookupPOI}.
 */
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
 * Probes `poi.db` on `name_key`, using the {@link normalizeLocalityForKey} fold that the POI build writes.
 *
 * The count is exact and unbounded.
 * A first call against a cold page cache can take seconds.
 */
export function lookupPOI<DB>(db: DatabaseClient<DB>, queries: string[], options: POILookupOptions = {}): LookupRow[] {
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
					`No POI is keyed ${stringifyJSON(key)}. ABSENCE. This probe is the exact-key path only; the runtime ` +
					"also has an FTS5 name path that can reach a row through a different tokenization.",
			}
		}

		if (wantCountry && !(countScoped.get(key, wantCountry) as { n: number }).n) {
			return {
				query,
				hit: true,
				entries: [],
				note:
					`The key ${stringifyJSON(key)} exists (${totalUnscoped} row(s)) but none in ${wantCountry}. ` +
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
				`${total} POI row(s) under key ${stringifyJSON(key)}` +
				(wantCountry ? ` in ${wantCountry}` : "") +
				`; the ${entries.length} above are the first by neg_rank.` +
				(key === query ? "" : ` Probed as ${stringifyJSON(key)}, not the string you typed.`),
		}
	})
}

/**
 * One codex fact about a string.
 * `table` identifies the reference table that answered.
 */
interface CodexEntry {
	table: string
	[key: string]: unknown
}

/**
 * Checks each string against every codex reference table: postcode shapes,
 * USPS street suffixes, unit designators, directionals and US states.
 *
 * This probe reads no artifact, so it is always available.
 * The postcode check tests shape only.
 *
 * For example, `68161` fits the US, German and French shapes.
 * The `candidate` and `postcode` sources answer membership.
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
 * The part of `PostcodeBinaryResolver` that this probe uses.
 */
export interface PostcodeAnchorResolver {
	lookup(postcode: string): Array<{ country: string; lat: number; lon: number }>
}

/**
 * Options for {@link lookupPostcodeAnchor}.
 */
export interface PostcodeLookupOptions {
	/**
	 * The span mode from the loaded package's model card.
	 *
	 * The default `alnum-run` mode splits on every non-alphanumeric character.
	 * It never produces a key for a code written with a space.
	 */
	spanMode: AnchorSpanMode
}

/**
 * Probes the `postcode-<cc>.bin` anchor artifact in the resolved weights package.
 *
 * The key is the query with whitespace removed and upper-cased, matching the training normalization.
 * A record at (0, 0) is a member without a centroid, and it still feeds the country posterior.
 *
 * Under `alnum-run`, a code containing a space is present in the artifact
 * but never reaches the model, and the note says so.
 */
export function lookupPostcodeAnchor(
	resolver: PostcodeAnchorResolver,
	queries: string[],
	options: PostcodeLookupOptions
): LookupRow[] {
	return queries.map((query) => {
		const key = query.replaceAll(/\s+/g, "").toUpperCase()
		// An alphanumeric run stops at any other character, so only `shaped` can key such a query.
		const reachableByScan = options.spanMode === "shaped" || !/[^\p{L}\p{N}]/u.test(query.trim())
		const rows = resolver.lookup(key)

		if (!rows.length) {
			return {
				query,
				hit: false,
				entries: null,
				note:
					`No record under key ${stringifyJSON(key)}. ABSENCE from this locale's anchor artifact — which is a ` +
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
			notes.push(`Keyed as ${stringifyJSON(key)} — space-stripped and upper-cased, the train painter's own key.`)
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
