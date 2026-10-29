/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `fragment-assay` collectors: real address parts harvested from OpenAddresses files, from Ryhti's
 *   building address file and from an existing corpus's spans.
 *
 *   No collector renders. Each returns surfaces, and `rows.ts` labels them. Each collector seeds its own
 *   `PyRandom` from {@linkcode FRAGMENT_SEED} and a per-collector key, so one collector's sampling leaves
 *   another's unchanged. Lengths are code-point lengths and sorts are code-point sorts, as the Python
 *   builder measured and sorted.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"
import { pythonIsDigit, pythonStrip } from "@mailwoman/core/strings/python-text"
import { CSVSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { codePointLength } from "#cjk/builder"
import { openParquetRowStream } from "#parquet/streams"
import { PyRandom } from "#training/pyrandom"

/**
 * OpenAddresses locale directory to ISO country, BCP 47 locale, and
 * whether the house number trails the street.
 */
export const OA_LOCALES: Readonly<Record<string, readonly [country: string, locale: string, trailing: boolean]>> = {
	cz: ["CZ", "cs-CZ", true],
	dk: ["DK", "da-DK", true],
	es: ["ES", "es-ES", true],
	hr: ["HR", "hr-HR", true],
	nl: ["NL", "nl-NL", true],
	no: ["NO", "nb-NO", true],
	pl: ["PL", "pl-PL", true],
	pt: ["PT", "pt-PT", true],
	si: ["SI", "sl-SI", true],
	sk: ["SK", "sk-SK", true],
	au: ["AU", "en-AU", false],
	nz: ["NZ", "en-NZ", false],
	ch: ["CH", "de-CH", true],
}

const POLISH_VOIVODESHIPS = [
	"dolnoslaskie",
	"kujawsko-pomorskie",
	"lodzkie",
	"lubelskie",
	"lubuskie",
	"malopolskie",
	"mazowieckie",
	"opolskie",
	"podkarpackie",
	"podlaskie",
	"pomorskie",
	"slaskie",
	"swietokrzyskie",
	"warminsko-mazurskie",
	"wielkopolskie",
	"zachodniopomorskie",
]

/**
 * The OpenAddresses files each locale reads, relative to `--oa-root`, in read order,
 * each with the register row of the body that publishes it.
 *
 * `corpus-source-inputs.json` lists every one of these rows under `fragment-assay`,
 * and each carries an elected decision permitting transform and train.
 * A file whose publisher has no such row is left out: Austria's BEV files, Finland's
 * 2021 DVV extract and Sweden's municipal files, the Australian state and council files,
 * the New Zealand council files, and the two `countrywide-cityfilled.csv` files under `dk/`
 * and `fi/`, whose CITY column was filled from an unrecorded source.
 *
 * `ch/countrywide.csv` is the 2021 extract of the BFS building and dwelling register (GWR),
 * whose level A data the BFS states may be used without restriction.
 * Finland's rows come from Ryhti ({@linkcode RYHTI_FILE}).
 */
export const OA_FILES: Readonly<Record<string, ReadonlyArray<readonly [file: string, registerRow: string]>>> = {
	au: [["au/countrywide.csv", "au-property-building-1"]],
	ch: [["ch/countrywide.csv", "ch-property-building-2"]],
	cz: [["cz/countrywide.csv", "cz-property-building-2"]],
	dk: [["dk/countrywide.csv", "dk-property-building-1"]],
	es: [["es/countrywide.csv", "es-property-building-1"]],
	hr: [["hr/countrywide.csv", "hr-property-building-1"]],
	nl: [["nl/countrywide.csv", "nl-property-building-2"]],
	no: [["no/countrywide.csv", "no-property-building-1"]],
	nz: [["nz/countrywide.csv", "nz-property-building-1"]],
	pl: POLISH_VOIVODESHIPS.map((voivodeship) => [`pl/${voivodeship}.csv`, "pl-property-building-1"] as const),
	pt: [["pt/countrywide.csv", "pt-property-building-1"]],
	si: [["si/countrywide.csv", "si-property-building-1"]],
	sk: [["sk/countrywide.csv", "sk-property-building-1"]],
}

/**
 * The corpus parts the global locality harvest reads, relative to `$MAILWOMAN_DATA_ROOT`.
 *
 * v0.5.0's first twelve train parts hold only wof-admin rows (register row us-geodata-aggregate-2).
 * Parts 0005 to 0009 hold the US, FR, DE, GB, ES, NL and IT locality spans
 * and part-0010 the CN, JP, KR and TW ones.
 */
export const LOCALITY_PARQUET_GLOB = "corpus/versioned/v0.5.0/corpus-v0.5.0/train/part-00*.parquet"

/**
 * Ryhti's building address file, relative to `$MAILWOMAN_DATA_ROOT`, published by
 * the Finnish Environment Institute under CC BY 4.0.
 */
export const RYHTI_FILE = "corpus/sources/ryhti/open_address.csv"

/**
 * The register row Ryhti's file is read under.
 */
export const RYHTI_REGISTER_ROW = "fi-property-building-1"

/**
 * The default number of street pairs a locale samples.
 */
export const PER_LOCALE_CAP = 4000

/**
 * The seed every collector's key extends, and the seed of the final shuffle.
 */
export const FRAGMENT_SEED = 42

/**
 * The wire identifier every row stores, and the prefix of each `source_id`.
 *
 * `RECIPE_SOURCES` in `lib/recipes/sources.ts` records it as the current
 * spelling of the retired `synth-fragment`.
 */
export const FRAGMENT_SOURCE = "fragment-assay"

/**
 * One address record as the collectors read it: street, number, city, postcode, unit, each trimmed.
 */
export type AddressRecord = readonly [street: string, number: string, city: string, postcode: string, unit: string]

/**
 * A locale's sampled pools.
 */
export interface LocaleParts {
	pairs: (readonly [street: string, number: string])[]
	cities: string[]
	cityPostcodes: (readonly [city: string, postcode: string])[]
	units: (readonly [unit: string, number: string, street: string])[]
	triples: (readonly [street: string, number: string, city: string])[]
}

/**
 * Python's tuple order over string tuples: element by element in code-point order, a shorter prefix first.
 */
export function compareStringTuples(left: readonly string[], right: readonly string[]): number {
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const order = compareByScalarValue(left[index]!, right[index]!)

		if (order) return order
	}

	return left.length - right.length
}

/**
 * A key a set of tuples holds: the parts joined by a separator no CSV cell holds.
 */
const tupleKey = (parts: readonly string[]) => parts.join("\0")

/**
 * A set of string tuples, kept by value.
 */
class TupleSet<T extends readonly string[]> {
	#items = new Map<string, T>()

	add(item: T): void {
		const key = tupleKey(item)

		if (!this.#items.has(key)) {
			this.#items.set(key, item)
		}
	}

	get size(): number {
		return this.#items.size
	}

	sorted(): T[] {
		return [...this.#items.values()].toSorted(compareStringTuples)
	}
}

const isBareDigits = (text: string) => pythonIsDigit(text)

/**
 * Each OpenAddresses file's records, its header matched in upper case so a file's
 * column order and spelling of `STREET` or `street` do not matter.
 * A file without a STREET column yields none.
 */
async function* oaRecords(paths: readonly string[]): AsyncGenerator<AddressRecord> {
	for (const path of paths) {
		let columns: (number | undefined)[] | null = null

		for await (const row of CSVSpliterator.fromAsync<string[]>(path, { header: false })) {
			if (!columns) {
				const index = new Map(row.map((name, position) => [name.toUpperCase(), position]))

				if (!index.has("STREET")) break

				columns = ["STREET", "NUMBER", "CITY", "POSTCODE", "UNIT"].map((name) => index.get(name))

				continue
			}

			const [street, number, city, postcode, unit] = columns.map((position) =>
				typeof position === "number" && position < row.length ? row[position]! : ""
			)

			yield [street!, number!, city!, postcode!, unit!]
		}
	}
}

const CITY_MIN = 3
const CITY_MAX = 48
const CONTEXT_CITY_MAX = 40
const POSTCODE_MIN = 3
const POSTCODE_MAX = 10
const STREET_MIN = 3
const STREET_MAX = 48
const UNIT_MAX = 12
const NUMBER_MAX = 8

/**
 * Accumulates distinct surfaces from `records` until `cap * 3` distinct streets
 * are held, then samples each pool.
 */
async function collectParts(records: AsyncIterable<AddressRecord>, rngKey: string, cap: number): Promise<LocaleParts> {
	const rng = new PyRandom(`${FRAGMENT_SEED}:${rngKey}`)
	const pairs = new Map<string, string>()
	const cities = new Set<string>()
	const cityPostcodes = new TupleSet<readonly [string, string]>()
	const units = new TupleSet<readonly [string, string, string]>()
	const triples = new TupleSet<readonly [string, string, string]>()

	for await (const [street, number, city, postcode, unit] of records) {
		const cityLength = codePointLength(city)

		if (city && cityLength >= CITY_MIN && cityLength <= CITY_MAX && !isBareDigits(city) && cities.size < cap * 3) {
			cities.add(city)
		}

		const postcodeLength = codePointLength(postcode)

		if (
			city &&
			postcode &&
			postcodeLength >= POSTCODE_MIN &&
			postcodeLength <= POSTCODE_MAX &&
			cityPostcodes.size < cap * 2
		) {
			cityPostcodes.add([city, postcode])
		}

		const streetLength = codePointLength(street)

		if (!street || streetLength < STREET_MIN || streetLength > STREET_MAX || isBareDigits(street)) continue

		const numberLength = codePointLength(number)

		if (unit && number && codePointLength(unit) <= UNIT_MAX && numberLength <= NUMBER_MAX && units.size < cap) {
			units.add([unit, number, street])
		}

		if (
			city &&
			number &&
			numberLength <= NUMBER_MAX &&
			cityLength >= CITY_MIN &&
			cityLength <= CONTEXT_CITY_MAX &&
			triples.size < cap
		) {
			triples.add([street, number, city])
		}

		if (!pairs.has(street)) {
			pairs.set(street, number)
		}

		if (pairs.size >= cap * 3) break
	}

	const half = Math.floor(cap / 2)
	const sample = <T>(items: T[], k: number) => rng.sample(items, Math.min(k, items.length))

	return {
		pairs: sample([...pairs].toSorted(compareStringTuples), cap),
		cities: sample([...cities].toSorted(compareByScalarValue), half),
		cityPostcodes: sample(cityPostcodes.sorted(), half),
		units: sample(units.sorted(), half),
		triples: sample(triples.sorted(), half),
	}
}

/**
 * The sampled pools of the OpenAddresses files {@linkcode OA_FILES} lists for a locale.
 *
 * @throws When a listed file is missing, naming every missing path.
 */
export async function collectOAParts(oaRoot: string, localeDirectory: string, cap: number): Promise<LocaleParts> {
	const files = OA_FILES[localeDirectory]

	if (!files) throw new Error(`no OpenAddresses files are listed for ${localeDirectory}`)

	const paths = files.map(([relative]) => `${oaRoot}/${relative}`)
	const absent: string[] = []

	for (const path of paths) {
		if (!(await pathExists(path))) {
			absent.push(path)
		}
	}

	if (absent.length) {
		throw new Error(`OpenAddresses files listed for ${localeDirectory} are absent: ${absent.join(", ")}`)
	}

	return collectParts(oaRecords(paths), localeDirectory, cap)
}

/**
 * Finnish-language records of Ryhti's `open_address.csv`.
 *
 * `address_fin` is the published rendering (`Vuorijärventie 216`), so the house
 * number is the text after the street name.
 * A row without a Finnish street name is skipped.
 */
async function* ryhtiRecords(path: string): AsyncGenerator<AddressRecord> {
	for await (const row of CSVSpliterator.fromAsync<Record<string, string | undefined>>(path, {
		normalizeKeys: false,
	})) {
		const street = row["address_name_fin"] || ""
		const rendered = row["address_fin"] || ""

		if (!street) continue

		const number = rendered.startsWith(`${street} `) ? pythonStrip(rendered.slice(street.length)) : ""

		yield [street, number, row["postal_office_fin"] || "", row["postal_code"] || "", ""]
	}
}

/**
 * The pools {@linkcode collectOAParts} returns, read from Ryhti's building address file.
 *
 * @throws When the file is missing, naming it.
 */
export async function collectRyhtiParts(path: string, cap: number): Promise<LocaleParts> {
	if (!(await pathExists(path))) throw new Error(`the Ryhti building address file is absent: ${path}`)

	return collectParts(ryhtiRecords(path), "fi-ryhti", cap)
}

/**
 * The files a glob matches, in code-point order.
 * A pattern without a glob character names one file.
 */
export async function matchingFiles(pattern: string): Promise<string[]> {
	if (!/[*?[{]/u.test(pattern)) return (await pathExists(pattern)) ? [pattern] : []

	const found: string[] = await Globerator.from(pattern, { absolute: true }).toArray()

	return found.toSorted(compareByScalarValue)
}

interface SpanRow {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string
}

/**
 * The batch length the Python harvest read, which decides where its stop condition was checked.
 */
const HARVEST_BATCH_ROWS = 8192

/**
 * Each file's span rows in batches of {@linkcode HARVEST_BATCH_ROWS}, a file's last batch short.
 */
async function* spanRowBatches(path: string): AsyncGenerator<SpanRow[]> {
	let batch: SpanRow[] = []

	for await (const row of openParquetRowStream<SpanRow>(path, {
		columns: ["raw", "span_starts", "span_ends", "span_tags", "country"],
	})) {
		batch.push(row)

		if (batch.length === HARVEST_BATCH_ROWS) {
			yield batch
			batch = []
		}
	}

	if (batch.length) {
		yield batch
	}
}

/**
 * The text of each `tag` span in a row, trimmed.
 */
function spanTexts(row: SpanRow, tag: string): string[] {
	const characters = [...row.raw]

	return row.span_tags.flatMap((each, index) =>
		each === tag ? [pythonStrip(characters.slice(row.span_starts[index], row.span_ends[index]).join(""))] : []
	)
}

/**
 * Bare surfaces of one span tag per country (all countries when `countries` is `null`), lifted from a corpus.
 *
 * The scan stops once every country holds `cap * 2` surfaces, checked after each batch.
 * `maxParts` bounds it, because a sparse country never reaches the bound
 * and the scan would otherwise read every part.
 */
export async function spanSurfacesFromCorpus(
	parquetGlob: string,
	countries: ReadonlySet<string> | null,
	cap: number,
	tag = "street",
	maxParts?: number
): Promise<Map<string, string[]>> {
	const rng = new PyRandom(`${FRAGMENT_SEED}:corpus`)
	const out = new Map<string, Set<string>>(countries ? [...countries].map((country) => [country, new Set()]) : [])
	const paths = (await matchingFiles(parquetGlob)).slice(0, maxParts)

	scan: for (const path of paths) {
		for await (const batch of spanRowBatches(path)) {
			for (const row of batch) {
				if (!countries && !out.has(row.country)) {
					out.set(row.country, new Set())
				}

				const surfaces = out.get(row.country)

				if (!surfaces || surfaces.size >= cap * 2) continue

				for (const surface of spanTexts(row, tag)) {
					const length = codePointLength(surface)

					if (length >= STREET_MIN && length <= STREET_MAX && !isBareDigits(surface)) {
						surfaces.add(surface)
					}
				}
			}

			if (out.size && [...out.values()].every((surfaces) => surfaces.size >= cap * 2)) break scan
		}
	}

	return new Map(
		[...out]
			.filter(([, surfaces]) => surfaces.size)
			.map(([country, surfaces]) => {
				const sorted = [...surfaces].toSorted(compareByScalarValue)

				return [country, rng.sample(sorted, Math.min(cap, sorted.length))]
			})
	)
}

const ADMIN_LOCALITY_MAX = 40
const ADMIN_REGION_MIN = 2
const ADMIN_REGION_MAX = 20

/**
 * (locality, region) surface pairs from the US corpus rows that hold both spans.
 * The last span of each tag wins.
 */
export async function adminPairsFromCorpus(
	parquetGlob: string,
	cap: number
): Promise<(readonly [locality: string, region: string])[]> {
	const rng = new PyRandom(`${FRAGMENT_SEED}:adminpairs`)
	const pairs = new TupleSet<readonly [string, string]>()

	scan: for (const path of await matchingFiles(parquetGlob)) {
		for await (const batch of spanRowBatches(path)) {
			for (const row of batch) {
				if (row.country !== "US" || pairs.size >= cap * 3) continue

				const locality = spanTexts(row, "locality").at(-1)
				const region = spanTexts(row, "region").at(-1)

				if (!locality || !region) continue

				const localityLength = codePointLength(locality)
				const regionLength = codePointLength(region)

				if (
					localityLength >= CITY_MIN &&
					localityLength <= ADMIN_LOCALITY_MAX &&
					regionLength >= ADMIN_REGION_MIN &&
					regionLength <= ADMIN_REGION_MAX
				) {
					pairs.add([locality, region])
				}
			}

			if (pairs.size >= cap * 3) break scan
		}
	}

	const sorted = pairs.sorted()

	return rng.sample(sorted, Math.min(cap, sorted.length))
}
