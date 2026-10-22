/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Draws a country's training rows from a complete adapter output so the sample spans the country's address forms
 *   rather than its densest streets, and measures the variety of both.
 *
 *   An address source lists one house after another: a city street contributes every number along it, and a city
 *   contributes thousands of such streets. A model trained on that order sees the same street, locality and form
 *   repeated. The sample here keeps at most a few rows per street and at most a fixed number per place (a locality
 *   with its dependent locality), and fills each place round-robin across its forms (which components are present,
 *   the street type, the script) and its postcodes. Places are then filled in rounds, so every place is represented
 *   once before any is represented twice, until the country's ceiling. The ceiling keeps one country from dominating
 *   a mixture.
 *
 *   The adapter output stays complete beside the sample, because the same rows feed retrieval.
 */

import { OFFICIAL_LANGUAGES } from "@mailwoman/codex/country/official-languages"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { tryParsingJSON } from "@mailwoman/core/json"
import { mulberry32, shuffleWith } from "@mailwoman/core/random"
import { resourceDictionaryPath } from "@mailwoman/dictionaries/paths"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { loadLibpostalCanonicalForms } from "#adapters/libpostal-dictionary"
import type { CanonicalRow } from "#types"

/**
 * The scripts a row's letters are classified into, in the order a tie is broken.
 */
const SCRIPTS = [
	"Latin",
	"Cyrillic",
	"Arabic",
	"Armenian",
	"Georgian",
	"Greek",
	"Hebrew",
	"Han",
	"Hangul",
	"Thai",
	"Devanagari",
] as const

const SCRIPT_PATTERNS = SCRIPTS.map((script) => [script, new RegExp(`\\p{Script=${script}}`, "u")] as const)

/**
 * The script most of `text`'s letters are written in, or `Other` when none
 * of {@link SCRIPTS} holds a letter.
 */
export function dominantScript(text: string): string {
	const counts = new Map<string, number>()

	for (const character of text) {
		if (!/\p{L}/u.test(character)) continue

		const script = SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(character))?.[0] ?? "Other"

		counts.set(script, (counts.get(script) ?? 0) + 1)
	}

	let best = "Other"
	let most = 0

	for (const [script, count] of counts) {
		if (count > most) {
			best = script
			most = count
		}
	}

	return best
}

/**
 * The street-type forms a country's addresses use, each mapped to its canonical
 * spelling, and which lexicon supplied them.
 */
export interface StreetTypeLexicon {
	readonly forms: ReadonlyMap<string, string>
	/**
	 * The libpostal languages read: the country's official languages that have a `street_types.txt`,
	 * or `all` when none does and every language's list was read instead.
	 */
	readonly languages: readonly string[] | "all"
}

/**
 * The libpostal street-type lexicon for `country`'s official languages.
 *
 * A country whose official languages have no libpostal list (Armenian, Uzbek, Kyrgyz) reads
 * every language's list, so a street written in a neighbor's language still counts its type.
 */
export async function loadStreetTypeLexicon(country: string): Promise<StreetTypeLexicon> {
	const official = (OFFICIAL_LANGUAGES[country.toUpperCase()]?.official ?? []).filter((code) => code.length === 2)
	const available: string[] = []

	for (const language of official) {
		if (await pathExists(resourceDictionaryPath("libpostal", language, "street_types.txt"))) {
			available.push(language)
		}
	}

	const every = async (): Promise<string[]> => {
		const files = await Globerator.from("*/street_types.txt", {
			cwd: resourceDictionaryPath("libpostal").toString(),
			absolute: false,
		}).toSorted()

		return files.map((file) => file.split("/")[0]!)
	}

	const languages = available.length ? available : await every()
	const forms = new Map<string, string>()

	for (const language of languages) {
		for (const [form, canonical] of await loadLibpostalCanonicalForms(language, "street_types.txt")) {
			if (form && !forms.has(form)) {
				forms.set(form, `${language}:${canonical}`)
			}
		}
	}

	return { forms, languages: available.length ? available : "all" }
}

/**
 * The canonical street type a street name carries, read from its first or last one or two words, or null.
 */
export function streetTypeOf(street: string, lexicon: StreetTypeLexicon): string | null {
	const words = street
		.toLowerCase()
		.split(/\s+/u)
		.map((word) => word.replaceAll(/^[\p{P}\p{S}]+|[,;:]+$/gu, ""))
		.filter((word) => word.length > 0)

	if (!words.length) return null

	const candidates = [
		words.slice(0, 2).join(" "),
		words.slice(-2).join(" "),
		words[0]!,
		words.at(-1)!,
		words[0]!.replace(/\.$/u, ""),
		words.at(-1)!.replace(/\.$/u, ""),
	]

	for (const candidate of candidates) {
		const canonical = lexicon.forms.get(candidate)

		if (canonical) return canonical
	}

	return null
}

/**
 * What one row contributes to a variety census.
 */
export interface RowVariety {
	readonly locality: string
	readonly dependentLocality: string | null
	/**
	 * The locality and the dependent locality together: the settlement a row is stratified by.
	 */
	readonly place: string
	readonly postcode: string | null
	readonly street: string | null
	readonly streetType: string | null
	readonly hasUnit: boolean
	readonly hasDependentLocality: boolean
	readonly hasVenue: boolean
	readonly streetless: boolean
	readonly script: string
	/**
	 * The components present, the street type and the script, joined: the row's form.
	 */
	readonly form: string
}

/**
 * Reads one canonical row's variety keys.
 *
 * The locality is the row's `locality`, else its `dependent_locality`, else its `region`,
 * so a streetless premise in a named place is stratified by that place.
 * The place a row is stratified by joins the dependent locality to it, so an Estonian village is
 * its own place rather than one of its municipality's, and a city's districts are each their own.
 */
export function rowVariety(row: Pick<CanonicalRow, "components" | "raw">, lexicon: StreetTypeLexicon): RowVariety {
	const { components } = row
	const street = components.street?.trim() || null
	const streetType = street ? streetTypeOf(street, lexicon) : null
	const script = dominantScript(row.raw)

	const tags = Object.keys(components)
		.filter((tag) => components[tag as keyof typeof components])
		.toSorted()

	const locality = components.locality ?? components.dependent_locality ?? components.region ?? ""
	const dependentLocality = components.dependent_locality ?? null

	return {
		locality,
		dependentLocality,
		place: `${locality}\u0000${dependentLocality ?? ""}`,
		postcode: components.postcode ?? null,
		street,
		streetType,
		hasUnit: Boolean(components.unit),
		hasDependentLocality: Boolean(components.dependent_locality),
		hasVenue: Boolean(components.venue),
		streetless: !street,
		script,
		form: `${tags.join("+")}|${streetType ?? "-"}|${script}`,
	}
}

/**
 * The variety measures of a set of rows.
 */
export interface VarietyMeasures {
	rows: number
	localities: number
	dependentLocalities: number
	/**
	 * Distinct locality and dependent-locality pairs.
	 */
	places: number
	postcodes: number
	streets: number
	streetTypes: number
	forms: number
	unitShare: number
	dependentLocalityShare: number
	venueShare: number
	streetlessShare: number
	postcodeShare: number
	scripts: Record<string, number>
	/**
	 * The share of rows in the largest locality, a measure of how concentrated the rows are.
	 */
	largestLocalityShare: number
}

/**
 * Accumulates {@link VarietyMeasures} one row at a time.
 */
export class VarietyCensus {
	#rows = 0
	#units = 0
	#dependent = 0
	#venues = 0
	#streetless = 0
	#withPostcode = 0
	readonly #localities = new Map<string, number>()
	readonly #dependentLocalities = new Set<string>()
	readonly #places = new Set<string>()
	readonly #postcodes = new Set<string>()
	readonly #streets = new Set<string>()
	readonly #streetTypes = new Set<string>()
	readonly #forms = new Set<string>()
	readonly #scripts = new Map<string, number>()

	add(variety: RowVariety): void {
		this.#rows++
		this.#localities.set(variety.locality, (this.#localities.get(variety.locality) ?? 0) + 1)
		this.#places.add(variety.place)

		if (variety.dependentLocality) {
			this.#dependentLocalities.add(`${variety.locality}\u0000${variety.dependentLocality}`)
		}

		if (variety.postcode) {
			this.#withPostcode++
			this.#postcodes.add(variety.postcode)
		}

		if (variety.street) {
			this.#streets.add(`${variety.locality}\u0000${variety.street}`)
		}

		if (variety.streetType) {
			this.#streetTypes.add(variety.streetType)
		}

		this.#forms.add(variety.form)
		this.#scripts.set(variety.script, (this.#scripts.get(variety.script) ?? 0) + 1)

		if (variety.hasUnit) {
			this.#units++
		}

		if (variety.hasDependentLocality) {
			this.#dependent++
		}

		if (variety.hasVenue) {
			this.#venues++
		}

		if (variety.streetless) {
			this.#streetless++
		}
	}

	measures(): VarietyMeasures {
		const share = (count: number) => (this.#rows ? Number((count / this.#rows).toFixed(4)) : 0)
		let largestLocality = 0

		for (const count of this.#localities.values()) {
			largestLocality = Math.max(largestLocality, count)
		}

		return {
			rows: this.#rows,
			localities: this.#localities.size,
			dependentLocalities: this.#dependentLocalities.size,
			places: this.#places.size,
			postcodes: this.#postcodes.size,
			streets: this.#streets.size,
			streetTypes: this.#streetTypes.size,
			forms: this.#forms.size,
			unitShare: share(this.#units),
			dependentLocalityShare: share(this.#dependent),
			venueShare: share(this.#venues),
			streetlessShare: share(this.#streetless),
			postcodeShare: share(this.#withPostcode),
			scripts: Object.fromEntries([...this.#scripts].toSorted((a, b) => b[1] - a[1])),
			largestLocalityShare: share(largestLocality),
		}
	}
}

/**
 * The limits a variety sample is drawn under.
 */
export interface VarietySampleLimits {
	/**
	 * The most rows kept from one street in one locality.
	 */
	perStreet: number
	/**
	 * The most rows kept from one place, a locality and dependent-locality pair.
	 */
	perPlace: number
	/**
	 * The most rows kept for the country.
	 */
	ceiling: number
	seed: number
}

/**
 * The selection key of one row: interned ids, so a country's rows fit in memory as integers.
 */
export interface SelectionKey {
	readonly place: number
	readonly street: number
	readonly form: number
	readonly postcode: number
}

/**
 * Groups `items` by the key `groupOf` assigns, in first-seen order.
 */
function groupBy<T>(items: readonly T[], groupOf: (item: T) => number): T[][] {
	const groups = new Map<number, T[]>()

	for (const item of items) {
		const key = groupOf(item)
		let group = groups.get(key)

		if (!group) {
			groups.set(key, (group = []))
		}

		group.push(item)
	}

	return [...groups.values()]
}

/**
 * Interleaves `lists`, the first item of each and then the second of each,
 * until every list is spent or `limit` items are taken.
 */
function interleave<T>(lists: readonly (readonly T[])[], limit: number): T[] {
	const ordered: T[] = []

	const total = Math.min(
		limit,
		lists.reduce((sum, list) => sum + list.length, 0)
	)

	for (let round = 0; ordered.length < total; round++) {
		for (const list of lists) {
			if (round < list.length && ordered.length < total) {
				ordered.push(list[round]!)
			}
		}
	}

	return ordered
}

/**
 * Chooses the row indices of a variety sample.
 *
 * Rows are visited in a seeded random order.
 * A street keeps its first {@link VarietySampleLimits.perStreet} rows.
 *
 * Within a place the kept rows are interleaved across forms, and within a form across postcodes,
 * and the first {@link VarietySampleLimits.perPlace} are the place's candidates.
 * Candidates are then taken by their rank within their place, lowest first, so every place supplies
 * its first row before any supplies its second, until {@link VarietySampleLimits.ceiling}.
 * The returned indices are ascending.
 */
export function selectVarietySample(keys: readonly SelectionKey[], limits: VarietySampleLimits): number[] {
	const order = keys.map((_, index) => index)

	shuffleWith(order, mulberry32(limits.seed))

	const perStreet = new Map<number, number>()
	const byPlace = new Map<number, number[]>()

	for (const index of order) {
		const key = keys[index]!
		const kept = perStreet.get(key.street) ?? 0

		if (kept >= limits.perStreet) continue

		perStreet.set(key.street, kept + 1)

		let rows = byPlace.get(key.place)

		if (!rows) {
			byPlace.set(key.place, (rows = []))
		}

		rows.push(index)
	}

	// Candidates bucketed by rank within their place.
	// The places' order is the shuffled first-seen order, so the partial last
	// round is a seeded draw across places.
	const byRank: number[][] = []

	for (const rows of byPlace.values()) {
		// Forms take turns, and within a form its postcodes take turns, so a rare form such as a unit row
		// is drawn as early as the common one and a form's rows spread across the place's postcodes.
		const forms = groupBy(rows, (index) => keys[index]!.form).map((formRows) =>
			interleave(
				groupBy(formRows, (index) => keys[index]!.postcode),
				limits.perPlace
			)
		)

		const ranked = interleave(forms, limits.perPlace)

		for (const [rank, index] of ranked.entries()) {
			;(byRank[rank] ??= []).push(index)
		}
	}

	const chosen: number[] = []

	for (const bucket of byRank) {
		if (chosen.length >= limits.ceiling) break

		chosen.push(...bucket.slice(0, limits.ceiling - chosen.length))
	}

	return chosen.toSorted((a, b) => a - b)
}

/**
 * What a variety-sample run read, wrote and measured.
 */
export interface VarietySampleReport {
	input: string
	inputSHA256: string
	output: string
	outputSHA256: string
	country: string
	limits: VarietySampleLimits
	streetTypeLanguages: readonly string[] | "all"
	/**
	 * Lines that did not parse as a canonical row of the requested country.
	 */
	skipped: Record<string, number>
	full: VarietyMeasures
	sample: VarietyMeasures
	/**
	 * The share of the full output's distinct values the sample keeps.
	 */
	coverage: { localities: number; places: number; postcodes: number; streetTypes: number; forms: number }
}

/**
 * Reads a complete adapter output, writes its variety sample to `output` and the
 * report beside it as `<output>.variety.json`, and returns the report.
 *
 * The input is read twice, once to key every row and once to copy the chosen lines,
 * so memory holds integers per row rather than the rows themselves.
 */
export async function writeVarietySample(options: {
	input: PathBuilderLike
	output: PathBuilderLike
	country: string
	limits: VarietySampleLimits
}): Promise<VarietySampleReport> {
	const { input, output, limits } = options
	const country = options.country.toUpperCase()
	const lexicon = await loadStreetTypeLexicon(country)

	const intern = () => {
		const ids = new Map<string, number>()

		return (value: string) => {
			let id = ids.get(value)

			if (typeof id !== "number") {
				ids.set(value, (id = ids.size))
			}

			return id
		}
	}

	const placeID = intern()
	const streetID = intern()
	const formID = intern()
	const postcodeID = intern()
	const keys: SelectionKey[] = []
	const lineOfKey: number[] = []
	const full = new VarietyCensus()
	const varieties: RowVariety[] = []
	const skipped: Record<string, number> = {}
	let line = -1

	for await (const text of TextSpliterator.fromAsync(input)) {
		line++

		if (!text.trim()) continue

		const row = tryParsingJSON(text) as CanonicalRow | null

		if (!row || typeof row !== "object" || !row.components || typeof row.raw !== "string") {
			skipped["unparseable"] = (skipped["unparseable"] ?? 0) + 1

			continue
		}

		if (row.country !== country) {
			skipped[`country:${row.country}`] = (skipped[`country:${row.country}`] ?? 0) + 1

			continue
		}

		const variety = rowVariety(row, lexicon)

		full.add(variety)
		varieties.push(variety)
		lineOfKey.push(line)

		keys.push({
			place: placeID(variety.place),
			// A streetless premise numbered within a place repeats that place as a street's
			// houses repeat the street, so the place is its street.
			// A named site (an Estonian farm) is its own name, as a street is.
			street: streetID(`${variety.place}\u0001${variety.street ?? row.components.venue ?? ""}`),
			form: formID(variety.form),
			postcode: postcodeID(variety.postcode ?? ""),
		})
	}

	const chosen = selectVarietySample(keys, limits)
	const sample = new VarietyCensus()
	const chosenLines = new Set<number>()

	for (const index of chosen) {
		sample.add(varieties[index]!)
		chosenLines.add(lineOfKey[index]!)
	}

	async function* selectedLines(): AsyncIterable<string> {
		let current = -1

		for await (const text of TextSpliterator.fromAsync(input)) {
			current++

			if (chosenLines.has(current)) {
				yield text
			}
		}
	}

	await writeLocalTextFile(selectedLines(), output)

	const fullMeasures = full.measures()
	const sampleMeasures = sample.measures()
	const ratio = (kept: number, total: number) => (total ? Number((kept / total).toFixed(4)) : 0)

	const report: VarietySampleReport = {
		input: resolvePath(input),
		inputSHA256: await sha256File(input),
		output: resolvePath(output),
		outputSHA256: await sha256File(output),
		country,
		limits,
		streetTypeLanguages: lexicon.languages,
		skipped,
		full: fullMeasures,
		sample: sampleMeasures,
		coverage: {
			localities: ratio(sampleMeasures.localities, fullMeasures.localities),
			places: ratio(sampleMeasures.places, fullMeasures.places),
			postcodes: ratio(sampleMeasures.postcodes, fullMeasures.postcodes),
			streetTypes: ratio(sampleMeasures.streetTypes, fullMeasures.streetTypes),
			forms: ratio(sampleMeasures.forms, fullMeasures.forms),
		},
	}

	await writeLocalJSONFile(report, `${resolvePath(output)}.variety.json`)

	return report
}
