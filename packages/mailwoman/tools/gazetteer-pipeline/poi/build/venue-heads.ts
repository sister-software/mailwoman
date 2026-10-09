/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds `@mailwoman/poi-taxonomy/data/venue-heads.json` from three name populations per country:
 *   venue names from an Overture places names file, place names from the Who's On First candidate
 *   database with postal codes excluded, and street spans from the train split of a corpus
 *   manifest. Names are split on whitespace and each word is normalized with `normalizeFSTToken`,
 *   the form the decoder's word groups carry, so a table key matches the word the prior reads.
 *
 *   A head's bias is the natural log of its venue rate over the higher of its place rate and street
 *   rate. Each rate adds half a name to its count, so a head absent from a population has a finite
 *   rate. A head that is the complete name of an admin place in the country is excluded, because a
 *   city name ends venue names such as `Hotel Adlon Berlin` without marking them.
 */

import { officialLanguagesAlpha3 } from "@mailwoman/codex/country/region-languages"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import type {
	VenueHeadBiases,
	VenueHeadCountry,
	VenueHeadEntries,
	VenueHeadPosition,
	VenueHeadTable,
} from "@mailwoman/poi-taxonomy/venue-heads"

/**
 * The minimum number of distinct venue names in which a head must appear before it gets an entry.
 */
export const MIN_SUPPORT = 30

/**
 * The minimum bias an entry carries.
 *
 * A head below twice its comparison rate adds less than `ln 2` logits
 * and is omitted to keep the packaged table small.
 */
export const MIN_BIAS = Math.LN2

/**
 * The minimum number of distinct venue names that a country needs for its own entries.
 *
 * A smaller country contributes to its language aggregates only.
 */
export const MIN_COUNTRY_VENUE_NAMES = 10_000

/**
 * A suffix entry that differs from the next shorter kept suffix by less than this many logits
 * is dropped, because the runtime falls back to that shorter suffix with nearly the same bias.
 */
export const SUFFIX_PRUNE_DELTA = 0.5

const MAX_SUFFIX_LENGTH = 8
const MIN_ALPHABETIC_SUFFIX_LENGTH = 4
const SPACELESS_SCRIPT_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]+$/u

/**
 * The placetypes whose single-word names are excluded as first-word
 * and last-word heads, whatever their population.
 *
 * A venue carries its town's name at either end (`Croydon Dental Practice`, `Hotel Adlon London`),
 * and in a large city those venues outnumber the place names ending in the city's name,
 * so the rates alone would admit `london` as a head.
 * Who's On First leaves population and importance empty on most localities, so neither
 * field can tell a town from a hamlet, and a hamlet named `Palace` removes that word too.
 *
 * A head word that is also a place name is then left to the model rather than the prior.
 */
const ADMIN_PLACETYPES = [
	"country",
	"region",
	"macroregion",
	"county",
	"macrocounty",
	"locality",
	"localadmin",
	"borough",
]

/**
 * Splits a name on whitespace into `normalizeFSTToken` words, dropping words
 * that normalize to the empty string.
 */
export function nameWords(name: string): string[] {
	return name
		.split(/\s+/u)
		.map(normalizeFSTToken)
		.filter((w) => w !== "")
}

/**
 * Returns the suffixes of `word` that the table counts: shorter than the word, at most eight characters,
 * and at least four characters unless the suffix is written in a script without spaces between words.
 */
export function wordSuffixes(word: string): string[] {
	const characters = [...word]
	const out: string[] = []

	for (let length = 1; length < characters.length && length <= MAX_SUFFIX_LENGTH; length++) {
		const suffix = characters.slice(-length).join("")

		if (length >= MIN_ALPHABETIC_SUFFIX_LENGTH || SPACELESS_SCRIPT_RE.test(suffix)) {
			out.push(suffix)
		}
	}

	return out
}

/**
 * Head counts for one population of one country.
 */
export class HeadCounts {
	names = 0
	readonly first = new Map<string, number>()
	readonly last = new Map<string, number>()
	readonly suffix = new Map<string, number>()

	/**
	 * Counts one name at each position.
	 */
	add(name: string): void {
		const words = nameWords(name)

		if (!words.length) return

		this.names++
		const lastWord = words.at(-1)!

		if (words.length >= 2) {
			increment(this.first, words[0]!)
			increment(this.last, lastWord)
		}

		for (const suffix of wordSuffixes(lastWord)) {
			increment(this.suffix, suffix)
		}
	}
}

function increment(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * The three populations of one country, and its admin place names written as one word.
 */
export interface CountryCounts {
	venue: HeadCounts
	place: HeadCounts
	street: HeadCounts
	adminWords: Set<string>
}

function rate(count: number, names: number): number {
	return (count + 0.5) / (names + 0.5)
}

const POSITIONS = ["first", "last", "suffix"] as const satisfies readonly VenueHeadPosition[]

/**
 * Scores one country's heads.
 *
 * A head needs {@link MIN_SUPPORT} venue names and a bias of at least {@link MIN_BIAS};
 * an admin place name is excluded at the first-word and last-word positions.
 */
export function scoreCountry(counts: CountryCounts): VenueHeadEntries {
	const entries: VenueHeadEntries = { first: {}, last: {}, suffix: {} }

	for (const position of POSITIONS) {
		for (const [head, venueCount] of counts.venue[position]) {
			if (venueCount < MIN_SUPPORT) continue

			if (position !== "suffix" && counts.adminWords.has(head)) continue
			const venueRate = rate(venueCount, counts.venue.names)
			const placeRate = rate(counts.place[position].get(head) ?? 0, counts.place.names)

			const streetRate = counts.street.names ? rate(counts.street[position].get(head) ?? 0, counts.street.names) : 0

			const bias = Math.log(venueRate / Math.max(placeRate, streetRate))

			if (bias >= MIN_BIAS) {
				entries[position][head] = round(bias)
			}
		}
	}

	entries.suffix = pruneSuffixes(entries.suffix)

	return entries
}

/**
 * Drops a suffix whose bias is within {@link SUFFIX_PRUNE_DELTA} of the next
 * shorter kept suffix it ends with.
 */
export function pruneSuffixes(suffixes: VenueHeadBiases): VenueHeadBiases {
	const byLength = Object.keys(suffixes).toSorted((a, b) => [...a].length - [...b].length || compareByCodePoint(a, b))
	const kept: VenueHeadBiases = {}

	for (const suffix of byLength) {
		const characters = [...suffix]
		let shorter: number | undefined

		for (let start = 1; start < characters.length && shorter === undefined; start++) {
			shorter = kept[characters.slice(start).join("")]
		}

		if (shorter === undefined || Math.abs(suffixes[suffix]! - shorter) >= SUFFIX_PRUNE_DELTA) {
			kept[suffix] = suffixes[suffix]!
		}
	}

	return kept
}

/**
 * Averages country entries into one language aggregate, weighting each country equally
 * and counting a head a country lacks as zero.
 * Means below {@link MIN_BIAS} are omitted.
 */
export function aggregateLanguage(members: readonly VenueHeadEntries[]): VenueHeadEntries {
	const out: VenueHeadEntries = { first: {}, last: {}, suffix: {} }

	for (const position of POSITIONS) {
		const sums = new Map<string, number>()

		for (const member of members) {
			for (const [head, bias] of Object.entries(member[position])) {
				sums.set(head, (sums.get(head) ?? 0) + bias)
			}
		}

		for (const [head, sum] of sums) {
			const mean = sum / members.length

			if (mean >= MIN_BIAS) {
				out[position][head] = round(mean)
			}
		}
	}

	out.suffix = pruneSuffixes(out.suffix)

	return out
}

function round(value: number): number {
	return Math.round(value * 100) / 100
}

function sorted(biases: VenueHeadBiases): VenueHeadBiases {
	return Object.fromEntries(Object.entries(biases).toSorted(([a], [b]) => compareByCodePoint(a, b)))
}

function sortedEntries<T extends VenueHeadEntries>(entries: T): T {
	return { ...entries, first: sorted(entries.first), last: sorted(entries.last), suffix: sorted(entries.suffix) }
}

/**
 * Inputs to {@link buildVenueHeadTable}.
 */
export interface BuildVenueHeadOptions {
	/**
	 * An Overture place-names Parquet file with `name` and `country` columns.
	 */
	venueNames: string
	/**
	 * The Who's On First candidate database.
	 */
	candidateDB: string
	/**
	 * A corpus `MANIFEST.json` whose train slices supply street spans.
	 */
	corpusManifest: string
	/**
	 * Rewrites a manifest slice path to a local path.
	 */
	slicePath?: (path: string) => string
	/**
	 * Output path.
	 * Defaults to the package's `data/venue-heads.json`.
	 */
	out?: string
	onProgress?: (line: string) => void
}

/**
 * Counts the three populations, scores each country, aggregates languages and writes the table.
 */
export async function buildVenueHeadTable(
	opts: BuildVenueHeadOptions
): Promise<{ path: string; table: VenueHeadTable }> {
	const progress = opts.onProgress ?? (() => {})
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const db = await (await DuckDBInstance.create()).connect()

	for (const statement of ["INSTALL sqlite; LOAD sqlite;", "SET threads=8;", "SET memory_limit='16GB';"]) {
		await db.run(statement)
	}

	await db.run(`ATTACH '${opts.candidateDB}' AS wof (TYPE sqlite, READ_ONLY)`)
	const counts = new Map<string, CountryCounts>()

	const countryCounts = (country: string): CountryCounts => {
		let entry = counts.get(country)

		if (!entry) {
			entry = { venue: new HeadCounts(), place: new HeadCounts(), street: new HeadCounts(), adminWords: new Set() }
			counts.set(country, entry)
		}

		return entry
	}

	const stream = async (label: string, sql: string, visit: (row: Record<string, unknown>) => void): Promise<void> => {
		const result = await db.stream(sql)
		const columns = result.columnNames()
		let rows = 0

		for (let chunk = await result.fetchChunk(); chunk && chunk.rowCount > 0; chunk = await result.fetchChunk()) {
			for (const row of chunk.getRowObjects(columns)) {
				visit(row as Record<string, unknown>)

				rows++
			}
		}

		progress(`${label}: ${rows.toLocaleString()} distinct names`)
	}

	const adminList = ADMIN_PLACETYPES.map((p) => `'${p}'`).join(",")
	const placeFilter = `p.placetype <> 'postalcode' AND k.name IS NOT NULL`

	const placeJoin = `FROM wof.candidate k
		JOIN wof.country_codes c ON c.id = k.country_id
		JOIN wof.placetype_codes p ON p.id = k.placetype_id`

	// Admin words first: every population's suffix counts skip a last word that is one.
	await stream(
		"admin",
		`SELECT DISTINCT c.code AS country, k.name AS name ${placeJoin} WHERE ${placeFilter} AND p.placetype IN (${adminList})`,
		(row) => {
			const words = nameWords(String(row.name))

			if (words.length === 1) {
				countryCounts(String(row.country)).adminWords.add(words[0]!)
			}
		}
	)

	await stream(
		"place",
		`SELECT DISTINCT c.code AS country, k.name AS name ${placeJoin} WHERE ${placeFilter}`,
		(row) => {
			const country = countryCounts(String(row.country))
			country.place.add(String(row.name))
		}
	)

	await stream(
		"venue",
		`SELECT DISTINCT country, name FROM read_parquet('${opts.venueNames}') WHERE length(country) = 2 AND name IS NOT NULL`,
		(row) => {
			const country = countryCounts(String(row.country))
			country.venue.add(String(row.name))
		}
	)

	const manifest = parseJSONStrict<{ slices: { split: string; path: string }[] }>(
		await readLocalTextFile(opts.corpusManifest)
	)

	const slicePath = opts.slicePath ?? ((path: string) => path)
	const files = manifest.slices.filter((s) => s.split === "train").map((s) => `'${slicePath(s.path)}'`)

	// Span offsets count UTF-16 code units and DuckDB's substring counts code points.
	// The two agree on every row without a character outside the Basic Multilingual
	// Plane, so those rows are skipped.
	// The table ships in a published package, so rows under ODbL or naming OpenStreetMap
	// in their license, and rows with no recorded license, contribute no street names.
	await stream(
		"street",
		`SELECT DISTINCT country, substring(raw, s + 1, e - s) AS name FROM (
			SELECT country, raw, unnest(span_tags) AS tag, unnest(span_starts) AS s, unnest(span_ends) AS e
			FROM read_parquet([${files.join(",")}], union_by_name = true)
			WHERE NOT regexp_matches(raw, '[\\x{10000}-\\x{10FFFF}]')
				AND license IS NOT NULL
				AND NOT regexp_matches(license, 'odbl|openstreetmap', 'i')
		) WHERE tag = 'street'`,
		(row) => {
			const country = countryCounts(String(row.country))
			country.street.add(String(row.name))
		}
	)

	db.closeSync()

	const countries: Record<string, VenueHeadCountry> = {}
	const countryLanguages: Record<string, string[]> = {}
	const languageMembers = new Map<string, VenueHeadEntries[]>()

	for (const [country, entry] of [...counts].toSorted(([a], [b]) => compareByCodePoint(a, b))) {
		if (!entry.venue.names) continue
		const languages = [...officialLanguagesAlpha3(country)]
		countryLanguages[country] = languages
		const scored = scoreCountry(entry)

		for (const language of languages) {
			const members = languageMembers.get(language) ?? []
			members.push(scored)
			languageMembers.set(language, members)
		}

		if (entry.venue.names >= MIN_COUNTRY_VENUE_NAMES) {
			countries[country] = {
				names: { venue: entry.venue.names, place: entry.place.names, street: entry.street.names },
				...sortedEntries(scored),
			}
		}
	}

	const languages: Record<string, VenueHeadEntries> = {}

	for (const [language, members] of [...languageMembers].toSorted(([a], [b]) => compareByCodePoint(a, b))) {
		languages[language] = sortedEntries(aggregateLanguage(members))
	}

	const table: VenueHeadTable = {
		version: 1,
		provenance: {
			venueSource: opts.venueNames,
			placeSource: opts.candidateDB,
			streetSource: opts.corpusManifest,
			minSupport: MIN_SUPPORT,
			minBias: round(MIN_BIAS),
			minCountryVenueNames: MIN_COUNTRY_VENUE_NAMES,
		},
		countries,
		languages,
		countryLanguages,
	}

	const path = opts.out ?? resolvePackagePath("@mailwoman/poi-taxonomy", "data", "venue-heads.json")
	await writeLocalJSONFile(table, path)

	return { path, table }
}
