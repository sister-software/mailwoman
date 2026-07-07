/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `country-balanced` shard recipe — the BALANCED, MODEL-FIRST country-coverage shard (#464). The
 *   shipped model is STARVED on `country` (P=R=F1=0 on the homograph eval), so this fills the void
 *   the way the `unit` shard did, but built to AVOID over-firing "trailing token ⇒ country". Three
 *   ingredients, ported faithfully from scripts/build-country-shard-balanced.mjs:
 *
 *   1. Breadth/recall — real OA skeletons (US/DE/FR/IT/NL) with a country token in a varied surface form
 *        from `@mailwoman/codex/country` (canonical / endonym / ISO code), + ~30% country-ABSENT
 *        negatives (teach O-emission, the precision floor).
 *   2. Homograph CONTRAST pairs — each true country-name homograph (Georgia, Jordan, Lebanon, Mexico,
 *        Peru, Turkey) rendered BOTH ways: as `country` (foreign-city context) AND as the US
 *        `region`/`locality` (US-ZIP context). Teaches that the label is CONTEXTUAL, not
 *        positional.
 *   3. Code-as-region negatives — 2-letter codes that are both a US state abbrev and an ISO country code
 *        (CA/GA/IN/MA/PA/AL) in US-ZIP context → must read as `region`, never `country`.
 *
 *   `--golden` emits a held-out synthetic val over the VT (US) + Berlin (DE) holdouts. This is a
 *   `generate`-mode recipe that still reads REAL tuples off disk — `--count` bounds the OUTPUT, not
 *   the input. The passed `random` (the framework LCG) is consumed in the exact call order the
 *   legacy script used.
 */

import { spawnSync } from "node:child_process"

import { COUNTRY_SURFACE_FORMS, CountryNames } from "@mailwoman/codex/country"
import type { ComponentTag } from "@mailwoman/core/types"

import { stableSourceID } from "../adapter.js"
import { alignRow } from "../align.js"
import type { CanonicalRow } from "../types.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

// v2: the country TOKEN is decoupled from the skeleton's locale and drawn from a BROAD pool — every
// ISO canonical name + every curated surface form (endonyms/abbrevs). Surface forms are over-weighted
// so endonyms/abbrevs ("Deutschland","USA","NL") get strong signal.
const COUNTRY_FORM_POOL = (() => {
	const surface = Object.values(COUNTRY_SURFACE_FORMS).flat() // endonyms + abbrevs + canonical (curated)
	const names = [...CountryNames]

	// all ~249 ISO canonical English names (breadth)
	return { surface, names }
})()
const COUNTRY_ABSENT_PROB = 0.3 // negatives: rows with NO country token → teach golden precision

/** A cached OpenAddresses extract + the implied iso2/region/render-order. */
interface CountrySource {
	zip: string
	csv: string
	iso2: string
	region: string
	order: string
}

// Multi-locale OA sources. region = implied admin where the extract is single-region (US states, DE
// Saxony); countrywide extracts (FR/IT/NL) read region from the CSV when present.
const SOURCES: readonly CountrySource[] = [
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", iso2: "US", region: "IA", order: "us" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", iso2: "US", region: "IL", order: "us" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", iso2: "US", region: "MT", order: "us" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", iso2: "US", region: "SD", order: "us" },
	{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", iso2: "DE", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv", iso2: "FR", region: "", order: "fr" },
	// ES uses the Spanish IGN schema, not the OA standard columns — skipped here (codex still recognizes
	// "España"/"Spain"). A dedicated IGN adapter is a follow-up.
	{ zip: "/tmp/oa-cache/it__countrywide.zip", csv: "it/countrywide.csv", iso2: "IT", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/nl__countrywide.zip", csv: "nl/countrywide.csv", iso2: "NL", region: "", order: "eu" },
]
// Held-out for --golden: Vermont (US holdout) + Berlin (DE holdout) — geographic split, never trained.
const EVAL_SOURCES: readonly CountrySource[] = [
	{ zip: "/tmp/oa-cache/us__vt__statewide.zip", csv: "us/vt/statewide.csv", iso2: "US", region: "VT", order: "us" },
	{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", iso2: "DE", region: "", order: "eu" },
]

/** A real tuple read out of a cached OA zip (+ the source's iso2/render-order). */
interface CountryTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	iso2: string
	order: string
}

function splitCSV(line: string): string[] {
	const out: string[] = []
	let cur = "",
		inQ = false

	for (let i = 0; i < line.length; i++) {
		const c = line[i]

		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else {
					inQ = false
				}
			} else {
				cur += c
			}
		} else if (c === '"') {
			inQ = true
		} else if (c === ",") {
			out.push(cur)
			cur = ""
		} else {
			cur += c
		}
	}
	out.push(cur)

	return out
}

function readTuples(source: CountrySource, limit: number): CountryTuple[] {
	// countrywide extracts (FR/IT/NL) are GB-scale — cap the bytes with `head` (read ~8 lines per wanted
	// tuple to survive dedup/skips) so the toString stays under V8's string limit.
	const maxLines = Math.max(limit * 8, 20000) + 1
	const r = spawnSync("bash", ["-c", `unzip -p "${source.zip}" "${source.csv}" | head -n ${maxLines}`], {
		maxBuffer: 1024 * 1024 * 1024,
		encoding: "buffer",
	})

	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)

		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)

	if (lines.length < 2) return []
	const header = splitCSV(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (n: string): number => header.indexOf(n)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iRegion = idx("region"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: CountryTuple[] = []
	const seen = new Set<string>()

	for (let li = 1; li < lines.length && tuples.length < limit; li++) {
		if (!lines[li]) continue
		const cells = splitCSV(lines[li]!)
		const street = get(cells, iStreet),
			locality = get(cells, iCity),
			house_number = get(cells, iNum)

		if (!street || !locality || !house_number) continue
		const key = `${house_number}|${street}|${locality}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({
			house_number,
			street,
			locality,
			region: get(cells, iRegion) || source.region,
			postcode: get(cells, iPost),
			iso2: source.iso2,
			order: source.order,
		})
	}

	return tuples
}

/** Pick a country token from the BROAD pool, or null (a country-absent negative). v2. */
function pickCountry(random: () => number): string | null {
	if (random() < COUNTRY_ABSENT_PROB) return null // negative — teaches "trailing token != always country"
	// 60% curated surface forms (endonym/abbrev variety), 40% broad ISO canonical names (coverage).
	const pool = random() < 0.6 ? COUNTRY_FORM_POOL.surface : COUNTRY_FORM_POOL.names

	return pool[Math.floor(random() * pool.length)]!
}

/** Render the address body in native-ish order. `country` null → a country-ABSENT negative row. */
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
		const regPc = [reg, pc].filter(Boolean).join(" ")
		body = `${hn} ${street}, ${loc}${regPc ? ", " + regPc : ""}`
	} else if (order === "fr") {
		// French is NUMBER-street, postcode-city: "84 Route de la Fontaine, 75008 Paris".
		body = `${hn} ${street}, ${[pc, loc].filter(Boolean).join(" ")}`
	} else {
		// DE/IT/NL: street-number, postcode-city: "Pariser Platz 1, 10117 Berlin".
		const pcCity = [pc, loc].filter(Boolean).join(" ")
		body = `${street} ${hn}, ${pcCity}`
	}

	if (!country) {
		// Negative: a normal address, NO country token/component. Teaches that a trailing region/city/
		// postcode is NOT a country (counters the v1 golden over-firing).
		return { fmt: "negative", raw: body, components }
	}
	const withC: Partial<Record<ComponentTag, string>> = { ...components, country }
	const r = random()

	if (r < 0.8) return { fmt: "full", raw: `${body}, ${country}`, components: withC }

	if (r < 0.92) return { fmt: "full-nl", raw: `${body}\n${country}`, components: withC }
	const bareBody = order === "us" || order === "fr" ? `${hn} ${street}, ${loc}` : `${street} ${hn}, ${loc}`

	return {
		fmt: "bare",
		raw: `${bareBody}, ${country}`,
		components: { house_number: hn, street, locality: loc, country },
	}
}

// ── Homograph contrast (the model-first addition) ───────────────────────────────────────────────
// True country-name homographs: the surface form is BOTH a country AND a US state/locality. Rendering
// each BOTH ways (foreign-city → country; US-ZIP → region/locality) is what teaches the CONTEXTUAL
// distinction. role: how the surface reads in US context.
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
// 2-letter codes that are BOTH a US state abbrev AND an ISO country code → must read as region in US ctx.
interface AbbrevRegion {
	code: string
	localities: readonly string[]
	postcodes: readonly string[]
}
const ABBREV_REGIONS: readonly AbbrevRegion[] = [
	{ code: "CA", localities: ["Los Angeles", "Sacramento", "San Diego"], postcodes: ["90012", "95814", "92101"] }, // California / Canada
	{ code: "GA", localities: ["Atlanta", "Savannah", "Macon"], postcodes: ["30309", "31401", "31201"] }, // Georgia(US) / Georgia
	{ code: "IN", localities: ["Indianapolis", "Fort Wayne"], postcodes: ["46204", "46802"] }, // Indiana / India
	{ code: "MA", localities: ["Boston", "Worcester"], postcodes: ["02108", "01608"] }, // Massachusetts / Morocco
	{ code: "PA", localities: ["Philadelphia", "Pittsburgh"], postcodes: ["19103", "15222"] }, // Pennsylvania / Panama
	{ code: "AL", localities: ["Birmingham", "Montgomery"], postcodes: ["35203", "36104"] }, // Alabama / Albania
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
const pick = <T>(random: () => number, arr: readonly T[]): T => arr[Math.floor(random() * arr.length)]!
const houseNo = (random: () => number): string => String(1 + Math.floor(random() * 998))

/**
 * A homograph CONTRAST row: ~half render the surface as `country` (foreign city), half as the US `region`/`locality`
 * (US ZIP, NO country). Returns iso2 for provenance.
 */
function renderHomograph(random: () => number): {
	fmt: string
	raw: string
	components: Partial<Record<ComponentTag, string>>
	iso2: string
} {
	const h = pick(random, HOMOGRAPHS)
	const hn = houseNo(random),
		street = pick(random, STREET_POOL)

	if (random() < 0.5) {
		const city = pick(random, h.cities)
		const withStreet = random() < 0.6
		const raw = withStreet ? `${hn} ${street}, ${city}, ${h.surface}` : `${city}, ${h.surface}`
		const components: Partial<Record<ComponentTag, string>> = withStreet
			? { house_number: hn, street, locality: city, country: h.surface }
			: { locality: city, country: h.surface }

		return { fmt: "homograph-country", raw, components, iso2: h.iso2 }
	}
	const pc = pick(random, h.us.postcodes)

	if (h.us.role === "region") {
		// surface is the US STATE: "123 Oak Ave, Atlanta, Georgia 30309" → region, no country
		return {
			fmt: "homograph-us-region",
			raw: `${hn} ${street}, ${h.us.locality}, ${h.surface} ${pc}`,
			components: { house_number: hn, street, locality: h.us.locality, region: h.surface, postcode: pc },
			iso2: "US",
		}
	}

	// surface is the US CITY: "123 Oak Ave, Lebanon, TN 37087" → locality, no country
	return {
		fmt: "homograph-us-locality",
		raw: `${hn} ${street}, ${h.surface}, ${h.us.region} ${pc}`,
		components: { house_number: hn, street, locality: h.surface, region: h.us.region, postcode: pc },
		iso2: "US",
	}
}

/** An abbrev-as-region negative: "123 Main St, Los Angeles, CA 90012" → region CA, NO country. */
function renderAbbrevRegion(random: () => number): {
	fmt: string
	raw: string
	components: Partial<Record<ComponentTag, string>>
	iso2: string
} {
	const a = pick(random, ABBREV_REGIONS)
	const hn = houseNo(random),
		street = pick(random, STREET_POOL),
		locality = pick(random, a.localities),
		postcode = pick(random, a.postcodes)

	return {
		fmt: "abbrev-region",
		raw: `${hn} ${street}, ${locality}, ${a.code} ${postcode}`,
		components: { house_number: hn, street, locality, region: a.code, postcode },
		iso2: "US",
	}
}

const HOMOGRAPH_FRAC = 0.22 // share of rows that are homograph contrast pairs
const ABBREV_FRAC = 0.08 // share that are code-as-region negatives (cumulative with HOMOGRAPH_FRAC)

export const countryBalancedRecipe: ShardRecipe = {
	name: "country-balanced",
	description: "Balanced model-first country rows (#464): OA skeletons + ISO surface forms + homograph contrast pairs",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the held-out VT+Berlin eval slice" }],
	async run(opts, write) {
		if (opts.count == null) throw new Error("country-balanced recipe requires --count <N>")
		const count = opts.count
		// Legacy build-country-shard-balanced.mjs seeded mulberry32 with the raw seed: `const random = mulberry32(opts.seed)`.
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-country"
		const sources = opts.golden ? EVAL_SOURCES : SOURCES
		const perSource = Math.ceil((count * 3) / sources.length) // over-read; balance locales

		const pool: CountryTuple[] = []

		for (const s of sources) {
			const t = readTuples(s, perSource)
			console.error(`  ${s.csv} (${s.iso2}): ${t.length} tuples`)

			for (const x of t) {
				pool.push(x)
			}
		}

		if (pool.length === 0) {
			throw new Error("No tuples — are the cached OA zips present in /tmp/oa-cache?")
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 8) {
			// Mix three row types: homograph contrast (the distinction), code-as-region negatives, and the
			// breadth/recall main path (random ISO form on an OA skeleton, ~30% country-absent).
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
				const country = pickCountry(random) // may be null → a country-absent negative row
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
				write(JSON.stringify({ raw, components, country: rowISO2 }) + "\n")
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
			write(JSON.stringify({ ...aligned.row, synth_method: "country", synth_base_id: null }) + "\n")
			emitted++
		}

		return { emitted, skipped }
	},
}
