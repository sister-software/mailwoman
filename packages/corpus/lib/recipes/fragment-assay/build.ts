/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Assembles the `fragment-assay` recipe output from real address parts, and separates its 10% dev holdout.
 *
 *   Every row is pushed onto one list, and its `source_id` stores its index there, so the order the blocks run
 *   in is part of every id and of the holdout the final shuffle separates: the OpenAddresses locales in sorted
 *   order, Finland from Ryhti, the corpus harvest, then the country counterweight. A block added in the middle
 *   renumbers every row after it.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { orderedJSON } from "@mailwoman/core/json"
import { pySum } from "@mailwoman/core/numeric"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { splitWhitespace } from "@mailwoman/core/strings/unicode"
import { TextSpliterator } from "spliterator"

import { ParquetColumnKind, type ParquetColumns, writeColumnParquetFile } from "#parquet/writers"
import {
	codexCountrySurfaces,
	type FragmentRow,
	renderCompactUnit,
	renderContext,
	renderCountryContext,
	renderCountryLeading,
	renderFragment,
	renderLocalityPostcode,
	renderLocalityRegion,
} from "#recipes/fragment-assay/rows"
import {
	adminPairsFromCorpus,
	collectOAParts,
	collectRyhtiParts,
	FRAGMENT_SEED,
	FRAGMENT_SOURCE,
	type LocaleParts,
	OA_LOCALES,
	spanSurfacesFromCorpus,
} from "#recipes/fragment-assay/sources"
import { stampRowLicenses } from "#source-register/row-license"
import { PyRandom } from "#training/pyrandom"

/**
 * The columns of the recipe output, in the order and with the types pyarrow
 * inferred for the Python builder's rows.
 */
export const FRAGMENT_COLUMNS: ParquetColumns = [
	["raw", ParquetColumnKind.String],
	["tokens", ParquetColumnKind.StringList],
	["labels", ParquetColumnKind.StringList],
	["span_starts", ParquetColumnKind.Int64List],
	["span_ends", ParquetColumnKind.Int64List],
	["span_tags", ParquetColumnKind.StringList],
	["country", ParquetColumnKind.String],
	["locale", ParquetColumnKind.String],
	["source", ParquetColumnKind.String],
	["source_id", ParquetColumnKind.String],
	["license", ParquetColumnKind.String],
	["register", ParquetColumnKind.String],
	["surface", ParquetColumnKind.String],
	["base_source_id", ParquetColumnKind.Null],
]

/**
 * One row of the recipe output before its license is stamped.
 */
export interface FragmentAssayRow extends FragmentRow {
	country: string
	locale: string
	source: string
	source_id: string
	license: string
	register: string | null
	surface: string
	base_source_id: null
}

/**
 * Options for {@linkcode buildFragmentAssay}.
 */
export interface FragmentAssayOptions {
	oaRoot: string
	corpusParquetGlob: string
	/**
	 * A newline list of top-population locality names, or empty for none.
	 */
	famousLocalitiesFile: string
	/**
	 * The glob of the global locality harvest, or empty to read `corpusParquetGlob`.
	 */
	localityParquetGlob: string
	/**
	 * Ryhti's building address file, or empty for no Finnish rows.
	 */
	ryhtiFile: string
	outParquet: string
	outDev: string
	perLocaleCap: number
	/**
	 * Each country's tail surfaces.
	 *
	 * @defaultValue {@linkcode codexCountrySurfaces}
	 */
	countrySurfaces?: ReadonlyMap<string, readonly string[]>
}

type Push = (row: FragmentRow, country: string, locale: string, note: string) => void

const NUMBER_MAX = 8

/**
 * One locale's pools in block order: bare street, street with number, bare locality,
 * locality with postcode, unit, comma-free context, then the country counterweight.
 */
function pushLocaleParts(
	push: Push,
	parts: LocaleParts,
	[country, locale, trailing]: readonly [string, string, boolean],
	note: string,
	label: string,
	surfaces: ReadonlyMap<string, readonly string[]>
): void {
	for (const [street, number] of parts.pairs) {
		push(renderFragment(street, null), country, locale, note)

		if (trailing && number && [...number].length <= NUMBER_MAX) {
			push(renderFragment(street, number), country, locale, note)
		}
	}

	for (const city of parts.cities) {
		push(renderFragment(city, null, "locality"), country, locale, note)
	}

	for (const [city, postcode] of parts.cityPostcodes) {
		push(renderLocalityPostcode(city, postcode), country, locale, note)
	}

	for (const [unit, number, street] of parts.units) {
		push(renderCompactUnit(unit, number, street), country, locale, note)
	}

	for (const [index, [street, number, city]] of parts.triples.entries()) {
		push(renderContext(street, number, city, country, trailing, index % 2 === 0), country, locale, note)
	}

	const forms = surfaces.get(country) ?? []

	if (forms.length) {
		for (const [index, [street, number, city]] of parts.triples.entries()) {
			if (!number || [...number].length > NUMBER_MAX) continue

			const surface = forms[index % forms.length]!

			push(renderCountryContext(street, number, city, surface, trailing, true), country, locale, note)
			push(renderCountryContext(street, number, city, surface, trailing, false), country, locale, note)
		}
	}

	console.log(
		`${label}: ${parts.pairs.length} pairs, ${parts.cities.length} localities, ${parts.cityPostcodes.length} loc+pc, ` +
			`${parts.units.length} units, ${parts.triples.length} context`
	)
}

const DIRECTIONALS = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST", "NE", "NW", "SE", "SW"])

const ASCII_END = 0x80

/**
 * Python's `str.isascii`: every code point below U+0080, an empty string included.
 */
const isASCII = (text: string) => [...text].every((character) => character.codePointAt(0)! < ASCII_END)

const byKey = <T>(entries: Iterable<readonly [string, T]>) =>
	[...entries].toSorted(([a], [b]) => compareByScalarValue(a, b))

async function readFamousLocalities(path: string): Promise<string[]> {
	if (!(await pathExists(path))) throw new Error(`the famous-localities file is absent: ${path}`)

	const names: string[] = []

	for await (const line of TextSpliterator.fromAsync(path)) {
		const name = line.trim()

		if (name) {
			names.push(name)
		}
	}

	return names
}

/**
 * The rows lifted from the corpus's spans, and the two pools the counterweight reuses.
 */
async function pushCorpusHarvest(options: FragmentAssayOptions, push: Push) {
	const cap = options.perLocaleCap
	const corpusStreets = await spanSurfacesFromCorpus(options.corpusParquetGlob, new Set(["US"]), cap, "street", 30)

	if (options.famousLocalitiesFile) {
		const famous = await readFamousLocalities(options.famousLocalitiesFile)

		for (const name of famous) {
			push(
				renderFragment(name, null, "locality"),
				"ZZ",
				"und",
				"Synthetic — fragment-assay; top-population locality names from the candidate gazetteer (WOF-derived)"
			)
		}

		console.log(`famous-locality twins: ${famous.length}`)
	}

	const adminPairs = await adminPairsFromCorpus(options.corpusParquetGlob, cap)

	for (const [locality, region] of adminPairs) {
		push(
			renderLocalityRegion(locality, region),
			"US",
			"en-US",
			"Synthetic — fragment-assay; (locality, region) pairs from corpus US spans"
		)
	}

	const directional = adminPairs.filter(([locality]) =>
		DIRECTIONALS.has(splitWhitespace(locality)[0]!.replace(/\.+$/u, "").toUpperCase())
	)

	for (const [locality] of directional) {
		push(
			renderFragment(locality, null, "locality"),
			"US",
			"en-US",
			"Synthetic — fragment-assay; directional-prefixed US localities (the N-Hartland flip class)"
		)
	}

	console.log(`US admin pairs: ${adminPairs.length} (directional-locality twins: ${directional.length})`)

	const corpusLocalities = await spanSurfacesFromCorpus(
		options.localityParquetGlob || options.corpusParquetGlob,
		null,
		Math.floor(cap / 4),
		"locality",
		12
	)

	for (const [country, localities] of byKey(corpusLocalities)) {
		for (const name of localities) {
			push(
				renderFragment(name, null, "locality"),
				country,
				"und",
				"Synthetic — fragment-assay; locality surfaces from corpus v0.5.0 spans"
			)
		}
	}

	console.log(
		`corpus locality twins: ${pySum([...corpusLocalities.values()].map((list) => list.length))} across ${corpusLocalities.size} countries`
	)

	for (const [country, streets] of byKey(corpusStreets)) {
		for (const street of streets) {
			push(
				renderFragment(street, null),
				country,
				"en-US",
				"Synthetic — fragment-assay; street surfaces from corpus v0.5.0 spans"
			)
		}

		console.log(`corpus:${country}: ${streets.length} bare streets`)
	}

	return { adminPairs, corpusLocalities }
}

const COUNTRY_CAP = 1500
const MAX_TAIL_NUMBER = 3999
const NUMBER_FIRST = new Set(["US", "GB", "CA", "FR"])

/**
 * The country rows: a tail-position block over US streets and localities, and a leading-position block.
 *
 * Their house numbers come from their own `PyRandom`, so a block before them
 * that changes size leaves them unchanged.
 */
async function pushCountryCounterweight(
	options: FragmentAssayOptions,
	push: Push,
	adminPairs: readonly (readonly [string, string])[],
	corpusLocalities: ReadonlyMap<string, string[]>,
	surfaces: ReadonlyMap<string, readonly string[]>
): Promise<void> {
	const note = "Synthetic — fragment-assay; #1104 country counterweight (corpus street × locality + codex surface tail)"
	const seedCountries = ["US"]
	const countryCap = Math.min(options.perLocaleCap, COUNTRY_CAP)

	const seedStreets = await spanSurfacesFromCorpus(
		options.corpusParquetGlob,
		new Set(seedCountries),
		countryCap,
		"street",
		40
	)

	const rng = new PyRandom(`${FRAGMENT_SEED}:countryrows`)
	const countryLocalities = new Map([["US", adminPairs.map(([locality]) => locality)]])
	let tailRows = 0

	for (const country of seedCountries.toSorted(compareByScalarValue)) {
		const forms = surfaces.get(country) ?? []
		const streets = (seedStreets.get(country) ?? []).filter(isASCII)
		const localities = (countryLocalities.get(country) ?? corpusLocalities.get(country) ?? []).filter(isASCII)

		if (!forms.length || !streets.length || !localities.length) continue

		const trailing = !NUMBER_FIRST.has(country)

		for (const [index, street] of streets.entries()) {
			const locality = localities[index % localities.length]!
			const number = String(rng.randint(1, MAX_TAIL_NUMBER))
			const surface = forms[index % forms.length]!

			push(renderCountryContext(street, number, locality, surface, trailing, true), country, "und", note)
			push(renderCountryContext(street, number, locality, surface, trailing, false), country, "und", note)
			tailRows += 2
		}
	}

	const regions = adminPairs.map(([, region]) => region)
	const localities = corpusLocalities.get("US") ?? []
	const usForms = surfaces.get("US") ?? []
	const multiWord = usForms.filter((form) => splitWhitespace(form).length >= 2)
	const leadingForms = multiWord.length ? multiWord : usForms
	let leadingRows = 0

	if (regions.length && localities.length && leadingForms.length) {
		for (let index = 0; index < Math.min(regions.length, countryCap); index++) {
			push(
				renderCountryLeading(
					leadingForms[index % leadingForms.length]!,
					regions[index]!,
					localities[index % localities.length]!
				),
				"US",
				"und",
				`${note} (leading)`
			)

			leadingRows++
		}
	}

	console.log(`#1104 country counterweight: ${tailRows} tail + ${leadingRows} leading rows`)
}

/**
 * Builds the recipe output: the train rows as parquet at `outParquet`,
 * the first tenth of the shuffle as JSONL at `outDev`.
 *
 * @throws When a listed input is missing, naming it, or a row's source has no license id.
 */
export async function buildFragmentAssay(options: FragmentAssayOptions): Promise<{ train: number; dev: number }> {
	const surfaces = options.countrySurfaces ?? codexCountrySurfaces()
	const shuffle = new PyRandom(FRAGMENT_SEED)
	const rows: FragmentAssayRow[] = []

	const pusher =
		(register: string | null, surface: string): Push =>
		(row, country, locale, note) => {
			rows.push({
				...row,
				country,
				locale,
				source: FRAGMENT_SOURCE,
				source_id: `${FRAGMENT_SOURCE}-${country}-${rows.length}`,
				license: note,
				register,
				surface,
				base_source_id: null,
			})
		}

	// The locale rows are OpenAddresses streets and localities written short.
	// The harvest rows are read back out of a built corpus, and their register varies per row.
	// The counterweight's country names come from the codex table.
	const localePush = pusher("openaddresses", "composed")

	for (const [directory, locale] of byKey(Object.entries(OA_LOCALES))) {
		pushLocaleParts(
			localePush,
			await collectOAParts(options.oaRoot, directory, options.perLocaleCap),
			locale,
			`Synthetic — fragment-assay; street/number/city from OpenAddresses ${directory}`,
			directory,
			surfaces
		)
	}

	if (options.ryhtiFile) {
		pushLocaleParts(
			pusher("ryhti", "composed"),
			await collectRyhtiParts(options.ryhtiFile, options.perLocaleCap),
			["FI", "fi-FI", true],
			"Synthetic — fragment-assay; street/number/city from Ryhti (Finnish Environment Institute, CC BY 4.0)",
			"fi (ryhti)",
			surfaces
		)
	}

	const { adminPairs, corpusLocalities } = await pushCorpusHarvest(options, pusher(null, "composed"))

	await pushCountryCounterweight(options, pusher("mailwoman-codex", "attested"), adminPairs, corpusLocalities, surfaces)

	shuffle.shuffle(rows)

	const stamped = await stampRowLicenses(rows, "fragment-assay build")
	const devCount = Math.floor(stamped.length / 10)
	const dev = stamped.slice(0, devCount)
	const train = stamped.slice(devCount)

	await writeColumnParquetFile(train, FRAGMENT_COLUMNS, options.outParquet)

	await writeLocalTextFile(
		dev.map((row) => orderedJSON(row)),
		options.outDev
	)

	console.log(`train: ${train.length} rows -> ${options.outParquet}`)
	console.log(`dev:   ${dev.length} rows -> ${options.outDev}`)

	return { train: train.length, dev: dev.length }
}
