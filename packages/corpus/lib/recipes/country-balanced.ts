/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds country-label training rows from OpenAddresses tuples and codex country names. The mix includes rows with no
 *   country and contrasts between country names and US place names. `--golden` reads held-out sources.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { COUNTRY_SURFACE_FORMS, CountryNames } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { stableSourceID } from "#adapters/utils"
import { readOATuples, requireRegister, type CorpusRecipe } from "#recipes/scaffold"
import { SurfaceOrigin } from "#types"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

// Country names are drawn without regard to the address's own country.
const COUNTRY_FORM_POOL = (() => {
	// `surface` holds curated endonyms and abbreviations, and `names` holds canonical English names.
	const surface = Object.values(COUNTRY_SURFACE_FORMS).flat()
	const names = [...CountryNames]

	return { surface, names }
})()

/**
 * The share of address rows rendered with no country.
 */
const COUNTRY_ABSENT_PROB = 0.3

/**
 * One OpenAddresses archive and how to render its rows.
 */
interface CountrySource {
	zip: PathBuilderLike
	csv: string
	iso2: string
	region: string
	order: string
}

/**
 * The training sources.
 */
const SOURCES: readonly CountrySource[] = [
	{
		zip: dataRootPath("oa-cache", "us__ia__statewide.zip"),
		csv: "us/ia/statewide.csv",
		iso2: "US",
		region: "IA",
		order: "us",
	},
	{ zip: dataRootPath("oa-cache", "us__il__cook.zip"), csv: "us/il/cook.csv", iso2: "US", region: "IL", order: "us" },
	{
		zip: dataRootPath("oa-cache", "us__mt__statewide.zip"),
		csv: "us/mt/statewide.csv",
		iso2: "US",
		region: "MT",
		order: "us",
	},
	{
		zip: dataRootPath("oa-cache", "us__sd__statewide.zip"),
		csv: "us/sd/statewide.csv",
		iso2: "US",
		region: "SD",
		order: "us",
	},
	{
		zip: dataRootPath("oa-cache", "de__sn__statewide.zip"),
		csv: "de/sn/statewide.csv",
		iso2: "DE",
		region: "",
		order: "eu",
	},
	{
		zip: dataRootPath("oa-cache", "fr__countrywide.zip"),
		csv: "fr/countrywide.csv",
		iso2: "FR",
		region: "",
		order: "fr",
	},
	{
		zip: dataRootPath("oa-cache", "it__countrywide.zip"),
		csv: "it/countrywide.csv",
		iso2: "IT",
		region: "",
		order: "eu",
	},
	{
		zip: dataRootPath("oa-cache", "nl__countrywide.zip"),
		csv: "nl/countrywide.csv",
		iso2: "NL",
		region: "",
		order: "eu",
	},
]

/**
 * The held-out sources that `--golden` reads.
 */
const EVAL_SOURCES: readonly CountrySource[] = [
	{
		zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
		csv: "us/vt/statewide.csv",
		iso2: "US",
		region: "VT",
		order: "us",
	},
	{ zip: dataRootPath("oa-cache", "de__berlin.zip"), csv: "de/berlin.csv", iso2: "DE", region: "", order: "eu" },
]

/**
 * An address tuple with its source country and rendering order.
 */
interface CountryTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	iso2: string
	order: string
}

/**
 * Reads up to `limit` tuples from one source archive.
 */
async function readTuples(source: CountrySource, limit: number): Promise<CountryTuple[]> {
	return readOATuples(source, {
		limit,
		extra: (fields, row) => ({
			...fields,
			region: row.region || source.region,
			iso2: source.iso2,
			order: source.order,
		}),
	})
}

// The share of country draws taken from the curated surface forms instead of canonical names.
const SURFACE_FORM_SHARE = 0.6

/**
 * Picks a country name, or returns `null` for a row with no country.
 */
function pickCountry(random: () => number): string | null {
	if (random() < COUNTRY_ABSENT_PROB) return null
	const pool = random() < SURFACE_FORM_SHARE ? COUNTRY_FORM_POOL.surface : COUNTRY_FORM_POOL.names

	return sample(pool, random)
}

// A draw below FULL_CUTOFF gives a comma before the country, a draw below FULL_NEWLINE_CUTOFF
// gives a newline, and any higher draw gives the bare form without region or postcode.
const FULL_CUTOFF = 0.8
const FULL_NEWLINE_CUTOFF = 0.92

/**
 * Renders an address in its source order, followed by the country when one is given.
 */
function renderCountry(
	random: () => number,
	t: CountryTuple,
	country: string | null
): { fmt: string; raw: string; components: Partial<Record<ComponentTag, string>> } {
	const { house_number: hn, street, locality: loc, region: reg, postcode: pc, order } = t
	const components: Partial<Record<ComponentTag, string>> = { house_number: hn, street, locality: loc }

	if (reg) {
		components.region = reg
	}

	if (pc) {
		components.postcode = pc
	}

	let body: string

	if (order === "us") {
		const regPc = [reg, pc].filter(isPresent).join(" ")
		body = `${hn} ${street}, ${loc}${regPc ? ", " + regPc : ""}`
	} else if (order === "fr") {
		// France uses number, street, postcode, locality.
		body = `${hn} ${street}, ${[pc, loc].filter(isPresent).join(" ")}`
	} else {
		// Germany, Italy and the Netherlands use street, number, postcode, locality.
		const pcCity = [pc, loc].filter(isPresent).join(" ")
		body = `${street} ${hn}, ${pcCity}`
	}

	if (!country) {
		return { fmt: "negative", raw: body, components }
	}

	const withC: Partial<Record<ComponentTag, string>> = { ...components, country }
	const r = random()

	if (r < FULL_CUTOFF) return { fmt: "full", raw: `${body}, ${country}`, components: withC }

	if (r < FULL_NEWLINE_CUTOFF) return { fmt: "full-nl", raw: `${body}\n${country}`, components: withC }
	const bareBody = order === "us" || order === "fr" ? `${hn} ${street}, ${loc}` : `${street} ${hn}, ${loc}`

	return {
		fmt: "bare",
		raw: `${bareBody}, ${country}`,
		components: { house_number: hn, street, locality: loc, country },
	}
}

// A name shared by a country and a US state or locality.
interface Homograph {
	surface: string
	iso2: string
	cities: readonly string[]
	us: { role: "region" | "locality"; locality: string; region: string; postcodes: readonly string[] }
}

const HOMOGRAPHS: readonly Homograph[] = [
	{
		surface: "Georgia",
		iso2: "GE",
		cities: ["Tbilisi", "Batumi", "Kutaisi", "Rustavi"],
		us: { role: "region", locality: "Atlanta", region: "Georgia", postcodes: ["30309", "31401", "30601", "31201"] },
	},
	{
		surface: "Jordan",
		iso2: "JO",
		cities: ["Amman", "Irbid", "Zarqa", "Aqaba"],
		us: { role: "locality", locality: "Jordan", region: "MN", postcodes: ["55352"] },
	},
	{
		surface: "Lebanon",
		iso2: "LB",
		cities: ["Beirut", "Tripoli", "Sidon", "Byblos"],
		us: { role: "locality", locality: "Lebanon", region: "TN", postcodes: ["37087", "03766", "17042", "45036"] },
	},
	{
		surface: "Mexico",
		iso2: "MX",
		cities: ["Guadalajara", "Monterrey", "Puebla", "Oaxaca"],
		us: { role: "locality", locality: "Mexico", region: "MO", postcodes: ["65265"] },
	},
	{
		surface: "Peru",
		iso2: "PE",
		cities: ["Cusco", "Arequipa", "Trujillo", "Iquitos"],
		us: { role: "locality", locality: "Peru", region: "IL", postcodes: ["61354", "46970"] },
	},
	{
		surface: "Turkey",
		iso2: "TR",
		cities: ["Ankara", "Izmir", "Bursa", "Antalya"],
		us: { role: "locality", locality: "Turkey", region: "TX", postcodes: ["79261", "28393"] },
	},
]

// A US state code that is also an ISO country code.
interface AbbrevRegion {
	code: string
	localities: readonly string[]
	postcodes: readonly string[]
}

// The paired countries are Canada, Georgia, India, Morocco, Panama and Albania.
const ABBREV_REGIONS: readonly AbbrevRegion[] = [
	{ code: "CA", localities: ["Los Angeles", "Sacramento", "San Diego"], postcodes: ["90012", "95814", "92101"] },
	{ code: "GA", localities: ["Atlanta", "Savannah", "Macon"], postcodes: ["30309", "31401", "31201"] },
	{ code: "IN", localities: ["Indianapolis", "Fort Wayne"], postcodes: ["46204", "46802"] },
	{ code: "MA", localities: ["Boston", "Worcester"], postcodes: ["02108", "01608"] },
	{ code: "PA", localities: ["Philadelphia", "Pittsburgh"], postcodes: ["19103", "15222"] },
	{ code: "AL", localities: ["Birmingham", "Montgomery"], postcodes: ["35203", "36104"] },
]

const STREET_POOL: readonly string[] = [
	"Main Street",
	"Oak Avenue",
	"Park Road",
	"Elm Street",
	"Hill Road",
	"Market Street",
	"Church Street",
	"King Street",
	"2nd Avenue",
	"Maple Drive",
]

const houseNo = (random: () => number): string => String(1 + Math.floor(random() * 998))

// The share of country-reading homograph rows that include a street address.
const HOMOGRAPH_WITH_STREET_SHARE = 0.6

/**
 * Renders a homograph as either the country or the US place, with the matching country code.
 */
function renderHomograph(random: () => number): {
	fmt: string
	raw: string
	components: Partial<Record<ComponentTag, string>>
	iso2: string
} {
	const h = sample(HOMOGRAPHS, random)

	const hn = houseNo(random),
		street = sample(STREET_POOL, random)

	if (random() < 0.5) {
		const city = sample(h.cities, random)
		const withStreet = random() < HOMOGRAPH_WITH_STREET_SHARE
		const raw = withStreet ? `${hn} ${street}, ${city}, ${h.surface}` : `${city}, ${h.surface}`

		const components: Partial<Record<ComponentTag, string>> = withStreet
			? { house_number: hn, street, locality: city, country: h.surface }
			: { locality: city, country: h.surface }

		return { fmt: "homograph-country", raw, components, iso2: h.iso2 }
	}

	const pc = sample(h.us.postcodes, random)

	if (h.us.role === "region") {
		return {
			fmt: "homograph-us-region",
			raw: `${hn} ${street}, ${h.us.locality}, ${h.surface} ${pc}`,
			components: { house_number: hn, street, locality: h.us.locality, region: h.surface, postcode: pc },
			iso2: "US",
		}
	}

	return {
		fmt: "homograph-us-locality",
		raw: `${hn} ${street}, ${h.surface}, ${h.us.region} ${pc}`,
		components: { house_number: hn, street, locality: h.surface, region: h.us.region, postcode: pc },
		iso2: "US",
	}
}

/**
 * Renders a US address whose state code is also a country code.
 */
function renderAbbrevRegion(random: () => number): {
	fmt: string
	raw: string
	components: Partial<Record<ComponentTag, string>>
	iso2: string
} {
	const a = sample(ABBREV_REGIONS, random)

	const hn = houseNo(random),
		street = sample(STREET_POOL, random),
		locality = sample(a.localities, random),
		postcode = sample(a.postcodes, random)

	return {
		fmt: "abbrev-region",
		raw: `${hn} ${street}, ${locality}, ${a.code} ${postcode}`,
		components: { house_number: hn, street, locality, region: a.code, postcode },
		iso2: "US",
	}
}

/**
 * The share of rows that are homograph contrasts.
 */
const HOMOGRAPH_FRAC = 0.22
/**
 * The share of rows that are state-code contrasts.
 */
const ABBREV_FRAC = 0.08

/**
 * The country-balanced recipe registered with the corpus builder.
 */
export const countryBalancedRecipe: CorpusRecipe = {
	name: "country-balanced",
	description: "Balanced model-first country rows (#464): OA skeletons + ISO surface forms + homograph contrast pairs",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the held-out VT+Berlin eval set" }],
	async run(opts, write) {
		if (opts.count == null) throw new Error("country-balanced recipe requires --count <N>")
		const count = opts.count
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-country"
		const sources = opts.golden ? EVAL_SOURCES : SOURCES
		// Reading three times the target leaves room for skipped rows.
		const perSource = Math.ceil((count * 3) / sources.length)

		const pool: CountryTuple[] = []

		for (const s of sources) {
			const t = await readTuples(s, perSource)

			console.error(`  ${s.csv} (${s.iso2}): ${t.length} tuples`)

			for (const x of t) {
				pool.push(x)
			}
		}

		if (!pool.length) {
			throw new Error(`No tuples — are the cached OA zips present in ${dataRootPath("oa-cache")}?`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 8) {
			const roll = random()
			let rendered: { fmt: string; raw: string; components: Partial<Record<ComponentTag, string>> }
			let rowISO2: string

			if (roll < HOMOGRAPH_FRAC) {
				const h = renderHomograph(random)
				rendered = h
				rowISO2 = h.iso2
			} else if (roll < HOMOGRAPH_FRAC + ABBREV_FRAC) {
				const a = renderAbbrevRegion(random)
				rendered = a
				rowISO2 = a.iso2
			} else {
				const t = pool[Math.floor(random() * N)]!
				const country = pickCountry(random)
				rendered = renderCountry(random, t, country)
				rowISO2 = t.iso2

				if (country && !rendered.raw.includes(country)) {
					skipped++

					continue
				}
			}

			const { raw, components } = rendered
			const localeTag = rowISO2 === "US" ? "en-US" : `${rowISO2.toLowerCase()}-${rowISO2}`

			if (opts.golden) {
				write(stringifyJSON({ raw, components, country: rowISO2 }))

				emitted++

				continue
			}

			const canonical: CanonicalRow = {
				raw,
				components,
				country: rowISO2,
				locale: localeTag,
				source,
				source_id: stableSourceID(source, components),
				corpus_version: "0.4.0",
				license: "OpenAddresses multi-locale skeletons + injected ISO-3166 country surface forms (codex)",
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(
				stringifyJSON({
					...aligned.row,
					recipe: "country",
					base_source_id: null,
					register: requireRegister(opts, "country-balanced"),
					surface: SurfaceOrigin.Composed,
				})
			)

			emitted++
		}

		return { emitted, skipped }
	},
}
