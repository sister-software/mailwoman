/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates US and French address rows that stress the boundaries between adjacent components.
 */

/* oxlint-disable mailwoman/prefer-home -- the admin tails below are written as US templates because every tuple this
   synthesizer draws from is `US_TUPLES`, a hardcoded US list. The comma-less arm is a deliberate malformation of that
   order, which a layout cannot express: it exists to stress the segmentation cue the commas carry. */

import type { DirectionalAbbreviation } from "@mailwoman/codex/us"
import { sample } from "@mailwoman/core/random"

import type { CanonicalRow } from "#types"

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs rather than thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
   output distribution, and reading the cascade top-to-bottom is how you see it. Naming each cutoff
   would hide the distribution behind a wall of identifiers. Genuine thresholds in these files are
   extracted as named constants above. */

/**
 * The row templates that {@link synthesizeBoundaryStressRow} can produce.
 */
export type BoundaryStressTemplate =
	| "street-eats-affix"
	| "comma-less-city-state"
	| "fr-prefix"
	| "house-number-after-street"
	| "bare-locality"
	| "house-number-before-street"

/**
 * A locality, region, postcode and country used as an address tail.
 */
export interface BoundaryStressBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

/**
 * Options for {@link synthesizeBoundaryStressRow}.
 */
export interface BoundaryStressSynthesisOpts {
	random?: () => number
	/**
	 * A template to use instead of a sampled one.
	 */
	forceTemplate?: BoundaryStressTemplate
}

/**
 * One synthesized row with its template.
 */
export interface SynthesizedBoundaryStressRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: BoundaryStressTemplate
}

const MULTIWORD_STREETS = [
	"Country Club",
	"Martin Luther King",
	"Forest Hill",
	"Lake View",
	"Spring Valley",
	"Cedar Ridge",
	"Old Mill",
	"Sunset Park",
	"Maple Grove",
	"Stone Creek",
	"Glen Cove",
	"Pine Bluff",
	"Fox Hollow",
	"Briar Patch",
	"West End",
	"College Station",
	"Quail Hollow",
	"Eagle Ridge",
	"Deer Run",
	"Bear Creek",
	"Willow Bend",
	"Cypress Point",
	"Laurel Oak",
	"Magnolia Park",
	"Cherry Hill",
	"Walnut Grove",
	"Birch Hollow",
	"Aspen Grove",
	"Juniper Ridge",
	"Hidden Valley",
	"Rolling Hills",
	"Tanglewood",
	"Meadow Brook",
	"Clover Field",
	"Sunrise Point",
	"Harbor View",
	"Bay Shore",
	"Ocean Breeze",
	"Mountain View",
	"Valley Forge",
	"Liberty Square",
	"Washington Crossing",
	"Kings Highway",
	"Queens Check",
	"Princeton Junction",
] as const

const SINGLE_STREETS = [
	"Main",
	"Oak",
	"Maple",
	"Park",
	"Washington",
	"Lincoln",
	"Church",
	"River",
	"Pine",
	"Cedar",
	"Elm",
	"Jefferson",
	"Madison",
	"Adams",
	"Jackson",
	"Franklin",
	"Highland",
	"Sunset",
	"Lakeview",
	"Hillcrest",
	"Cambridge",
	"Devonshire",
	"Sherwood",
	"Kingston",
	"Berkshire",
	"Aberdeen",
	"Belmont",
	"Carlisle",
	"Dover",
	"Easton",
	"Fairfax",
	"Greenwood",
	"1st",
	"2nd",
	"3rd",
	"4th",
	"5th",
	"12th",
	"42nd",
] as const

const SUFFIXES = [
	"St",
	"Street",
	"Ave",
	"Avenue",
	"Rd",
	"Road",
	"Blvd",
	"Boulevard",
	"Ln",
	"Lane",
	"Dr",
	"Drive",
	"Pkwy",
	"Parkway",
	"Way",
	"Ct",
	"Court",
	"Pl",
	"Place",
	"Cir",
	"Circle",
	"Ter",
	"Terrace",
	"Hwy",
	"Trail",
	"Loop",
	"Cres",
	"Crescent",
	"Row",
	"Walk",
] as const

// Keep the order fixed because seeded sampling depends on it.
const DIRECTIONALS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"] as const satisfies readonly DirectionalAbbreviation[]

const FR_PREFIXES = [
	"Rue",
	"Avenue",
	"Boulevard",
	"Place",
	"Impasse",
	"Chemin",
	"Quai",
	"Cours",
	"Allée",
	"Passage",
	"Square",
	"Villa",
	"Sentier",
	"Promenade",
] as const

const FR_NAMES = [
	"Jean-Baptiste Lebas",
	"Neuve-des-Capucines",
	"Charles-de-Gaulle",
	"du Général-Leclerc",
	"de la République",
	"des Trois-Frères",
	"Victor-Hugo",
	"Jean-Jaurès",
	"de l'Abreuvoir",
	"Émile-Zola",
	"Gambetta",
	"Jean-Moulin",
	"des Martyrs-de-la-Résistance",
	"du Maréchal-Foch",
	"Pierre-et-Marie-Curie",
	"Antoine-de-Saint-Exupéry",
	"de la Liberté",
	"des Quatre-Vents",
	"du Faubourg-Saint-Antoine",
	"Saint-Honoré",
	"de la Pompe",
	"des Petits-Champs",
	"Léon-Blum",
	"Aristide-Briand",
] as const

/**
 * Venue prefixes for bare-locality rows.
 *
 * The list uses only words that the base corpus labels as venue, and avoids words
 * that it mostly labels as street or locality.
 */
const VENUES = [
	"Community Center",
	"Health Center",
	"Medical Center",
	"Medical Clinic",
	"Family Clinic",
	"Community Clinic",
	"Dental Clinic",
	"Family Practice",
	"Medical Practice",
	"Dental Group",
	"Medical Group",
	"Health Department",
	"Elementary School",
	"Public School",
] as const

// The base corpus labels each of these localities as locality.
const US_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "Albuquerque", region: "NM", postcode: "87102", country: "US" },
	{ locality: "Indianapolis", region: "IN", postcode: "46203", country: "US" },
	{ locality: "Sacramento", region: "CA", postcode: "95823", country: "US" },
	{ locality: "Rochester", region: "NY", postcode: "14606", country: "US" },
	{ locality: "Jacksonville", region: "FL", postcode: "32209", country: "US" },
	{ locality: "Portsmouth", region: "VA", postcode: "23704", country: "US" },
	{ locality: "Merced", region: "CA", postcode: "95340", country: "US" },
	{ locality: "Miami", region: "FL", postcode: "33125", country: "US" },
	{ locality: "Tampa", region: "FL", postcode: "33624", country: "US" },
	{ locality: "Orlando", region: "FL", postcode: "32827", country: "US" },
	{ locality: "Tulsa", region: "OK", postcode: "74133", country: "US" },
	{ locality: "Louisville", region: "KY", postcode: "40203", country: "US" },
	{ locality: "Nashville", region: "TN", postcode: "37207", country: "US" },
	{ locality: "Spokane", region: "WA", postcode: "99202", country: "US" },
	{ locality: "Akron", region: "OH", postcode: "44313", country: "US" },
	{ locality: "Fairbanks", region: "AK", postcode: "99701", country: "US" },
	{ locality: "Plano", region: "TX", postcode: "75024", country: "US" },
	{ locality: "Shreveport", region: "LA", postcode: "71103", country: "US" },
	{ locality: "Southfield", region: "MI", postcode: "48034", country: "US" },
	{ locality: "Glendale", region: "CA", postcode: "91203", country: "US" },
	{ locality: "Philadelphia", region: "PA", postcode: "19104", country: "US" },
	{ locality: "Brooklyn", region: "NY", postcode: "11230", country: "US" },
	{ locality: "Bronx", region: "NY", postcode: "10461", country: "US" },
	{ locality: "Fairport", region: "NY", postcode: "14450", country: "US" },
	{ locality: "Syracuse", region: "NE", postcode: "68446", country: "US" },
	{ locality: "Marion", region: "AR", postcode: "72364", country: "US" },
	{ locality: "Chicago", region: "IL", postcode: "60625", country: "US" },
	{ locality: "Springfield", region: "MA", postcode: "01108", country: "US" },
]

// French rows carry no region component.
const FR_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "Paris", region: "", postcode: "75003", country: "FR" },
	{ locality: "Marseille", region: "", postcode: "13016", country: "FR" },
	{ locality: "Lyon", region: "", postcode: "69009", country: "FR" },
	{ locality: "Perpignan", region: "", postcode: "66000", country: "FR" },
	{ locality: "Toulon", region: "", postcode: "83100", country: "FR" },
	{ locality: "Avignon", region: "", postcode: "84140", country: "FR" },
	{ locality: "Poitiers", region: "", postcode: "86000", country: "FR" },
	{ locality: "Arles", region: "", postcode: "13280", country: "FR" },
	{ locality: "Annecy", region: "", postcode: "74940", country: "FR" },
	{ locality: "Mulhouse", region: "", postcode: "68200", country: "FR" },
	{ locality: "Carpentras", region: "", postcode: "84200", country: "FR" },
	{ locality: "Antony", region: "", postcode: "92160", country: "FR" },
	{ locality: "Sartrouville", region: "", postcode: "78500", country: "FR" },
	{ locality: "Épinal", region: "", postcode: "88000", country: "FR" },
	{ locality: "Meyzieu", region: "", postcode: "69330", country: "FR" },
	{ locality: "Sens", region: "", postcode: "89100", country: "FR" },
	{ locality: "Brunoy", region: "", postcode: "91800", country: "FR" },
	{ locality: "Rambouillet", region: "", postcode: "78120", country: "FR" },
]

const houseNumber = (random: () => number): string => String(1 + Math.floor(random() * 4999))
const localeFor: Record<string, string> = { US: "en-US", FR: "fr-FR", DE: "de-DE" }

const ALL_TEMPLATES: readonly BoundaryStressTemplate[] = [
	"street-eats-affix",
	"comma-less-city-state",
	"fr-prefix",
	"house-number-after-street",
	"bare-locality",
	"house-number-before-street",
]

/**
 * Synthesizes one row from a sampled or forced template.
 *
 * When `base` is absent, the function samples a built-in US or French tuple that suits the template.
 */
export function synthesizeBoundaryStressRow(
	base: BoundaryStressBaseTuple | undefined,
	opts: BoundaryStressSynthesisOpts = {}
): SynthesizedBoundaryStressRow {
	const random = opts.random ?? Math.random
	const template = opts.forceTemplate ?? sample(ALL_TEMPLATES, random)

	if (template === "bare-locality") {
		const b = base ?? (random() < 0.3 ? sample(FR_TUPLES, random) : sample(US_TUPLES, random))
		const venue = random() < 0.45 ? sample(VENUES, random) : ""
		const withCountry = random() < 0.12

		if (b.country === "FR") {
			const core = `${b.postcode} ${b.locality}${withCountry ? ", France" : ""}`

			return {
				raw: venue ? `${venue}, ${core}` : core,
				components: {
					...(venue ? { venue } : {}),
					postcode: b.postcode,
					locality: b.locality,
					...(withCountry ? { country: "France" } : {}),
				},
				locale: "fr-FR",
				template,
			}
		}

		const withZip = random() < 0.5
		const comma = random() < 0.6 ? "," : ""
		// The base corpus labels this spelling as country.
		const countryName = "United States"
		const core = `${b.locality}${comma} ${b.region}${withZip ? ` ${b.postcode}` : ""}${withCountry ? `, ${countryName}` : ""}`

		return {
			raw: venue ? `${venue}, ${core}` : core,
			components: {
				...(venue ? { venue } : {}),
				locality: b.locality,
				region: b.region,
				...(withZip ? { postcode: b.postcode } : {}),
				...(withCountry ? { country: countryName } : {}),
			},
			locale: "en-US",
			template,
		}
	}

	if (
		template === "fr-prefix" ||
		template === "house-number-after-street" ||
		template === "house-number-before-street"
	) {
		const b = base ?? sample(FR_TUPLES, random)
		const name = sample(FR_NAMES, random)
		const hn = houseNumber(random)

		if (template === "house-number-before-street") {
			// This form balances the number-after-street form with the same vocabulary.
			const raw = `${hn} ${name}, ${b.postcode} ${b.locality}`

			return {
				raw,
				components: { house_number: hn, street: name, postcode: b.postcode, locality: b.locality },
				locale: localeFor[b.country] ?? "fr-FR",
				template,
			}
		}

		if (template === "fr-prefix") {
			const prefix = sample(FR_PREFIXES, random)
			const raw = `${hn} ${prefix} ${name}, ${b.postcode} ${b.locality}`

			return {
				raw,
				components: {
					house_number: hn,
					street_prefix: prefix,
					street: name,
					postcode: b.postcode,
					locality: b.locality,
				},
				locale: localeFor[b.country] ?? "fr-FR",
				template,
			}
		}

		const raw = `${name} ${hn}, ${b.postcode} ${b.locality}`

		return {
			raw,
			components: { street: name, house_number: hn, postcode: b.postcode, locality: b.locality },
			locale: localeFor[b.country] ?? "fr-FR",
			template,
		}
	}

	const b = base ?? sample(US_TUPLES, random)
	const hn = houseNumber(random)
	const dir = random() < 0.4 ? sample(DIRECTIONALS, random) : ""
	const name = random() < 0.7 ? sample(MULTIWORD_STREETS, random) : sample(SINGLE_STREETS, random)
	const suffix = sample(SUFFIXES, random)
	const streetCore = `${dir ? `${dir} ` : ""}${name} ${suffix}`

	const components: CanonicalRow["components"] = {
		house_number: hn,
		...(dir ? { street_prefix: dir } : {}),
		street: name,
		street_suffix: suffix,
		locality: b.locality,
		region: b.region,
		postcode: b.postcode,
	}

	const raw =
		template === "comma-less-city-state"
			? `${hn} ${streetCore} ${b.locality} ${b.region} ${b.postcode}`
			: `${hn} ${streetCore}, ${b.locality}, ${b.region} ${b.postcode}`

	return { raw, components, locale: localeFor[b.country] ?? "en-US", template }
}
