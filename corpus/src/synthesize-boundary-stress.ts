/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Boundary-instability synthesizer (#375 — the highest-leverage parser lever). The failure taxonomy +
 *   the within-token-punctuation decomposition (#702) found one failure FAMILY surfacing under many
 *   names: the model mis-places token boundaries between adjacent components when the boundary is
 *   ambiguous or unmarked. This generator emits diverse BIO-labeled rows that put the gold boundary
 *   exactly where the model wobbles, so a retrain learns the boundary from context, not the lexeme.
 *
 *   The five token-aligned stress shapes (each component is a whitespace-separated token run, so
 *   `alignRow` labels them cleanly):
 *
 *   1. `street-eats-affix` — multi-word street + suffix (`Country Club Rd` → street + street_suffix),
 *        the #1 wobble: the model keeps the suffix in the street.
 *   2. `comma-less-city-state` — no comma between street / locality / region (`… North Sydney NSW
 *        2060`), the #694 family: concatenated input loses the segmentation cue.
 *   3. `fr-prefix` — FR street-type prefix split from the name (`Rue Jean-Baptiste Lebas` → street_prefix
 *        + street), postcode-first order.
 *   4. `house-number-after-street` — FR/DE number-follows-street (`Neuve-des-Capucines 5` → street +
 *        house_number), the model absorbs the number into the street.
 *   5. `au-uk-slash-unit` — the AU/NZ/UK unit/street-number slash (`4/2A` → unit + house_number,
 *        `Unit 11/2` → unit "Unit 11" + house_number 2). The aligner's tokenizer splits on `/`, so this
 *        labels cleanly (verified) — it does NOT collide with US `123 1/2` fractions because those are
 *        US-locale and keep `1/2` in house_number; the convention is locale-disambiguated.
 *
 *   The region+postcode glue shape (`NY14201`) is EXCLUDED — with no punctuation it stays one
 *   whitespace token spanning two components, which the token-BIO path can't label (a tokenizer
 *   concern, not a clean BIO shard case). `synthesize-boundary-stress.test.ts` proves the alignments.
 */

import type { CanonicalRow } from "./types.js"

export type BoundaryStressTemplate =
	| "street-eats-affix"
	| "comma-less-city-state"
	| "fr-prefix"
	| "house-number-after-street"
	| "au-uk-slash-unit"

export interface BoundaryStressBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

export interface BoundaryStressSynthesisOpts {
	random?: () => number
	/** Force a specific shape (tests + balanced shard composition). */
	forceTemplate?: BoundaryStressTemplate
}

export interface SynthesizedBoundaryStressRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: BoundaryStressTemplate
}

function pick<T>(arr: ReadonlyArray<T>, random: () => number): T {
	return arr[Math.floor(random() * arr.length)]!
}

// Multi-word street names — the suffix boundary only bites when "Club" could be read as part of the
// name. Single-word names alone teach nothing about the suffix edge.
// Multi-word names are what make the suffix boundary BITE (the model must not read the trailing
// suffix word as part of the name). Kept diverse so the shard teaches the boundary, not the lexeme.
const MULTIWORD_STREETS = [
	"Country Club", "Martin Luther King", "Forest Hill", "Lake View", "Spring Valley", "Cedar Ridge",
	"Old Mill", "Sunset Park", "Maple Grove", "Stone Creek", "Glen Cove", "Pine Bluff", "Fox Hollow",
	"Briar Patch", "West End", "College Station", "Quail Hollow", "Eagle Ridge", "Deer Run", "Bear Creek",
	"Willow Bend", "Cypress Point", "Laurel Oak", "Magnolia Park", "Cherry Hill", "Walnut Grove",
	"Birch Hollow", "Aspen Grove", "Juniper Ridge", "Hidden Valley", "Rolling Hills", "Tanglewood",
	"Meadow Brook", "Clover Field", "Sunrise Point", "Harbor View", "Bay Shore", "Ocean Breeze",
	"Mountain View", "Valley Forge", "Liberty Square", "Washington Crossing", "Kings Highway",
	"Queens Gate", "Princeton Junction",
] as const
const SINGLE_STREETS = [
	"Main", "Oak", "Maple", "Park", "Washington", "Lincoln", "Church", "River", "Pine", "Cedar", "Elm",
	"Jefferson", "Madison", "Adams", "Jackson", "Franklin", "Highland", "Sunset", "Lakeview", "Hillcrest",
	"Cambridge", "Devonshire", "Sherwood", "Kingston", "Berkshire", "Aberdeen", "Belmont", "Carlisle",
	"Dover", "Easton", "Fairfax", "Greenwood", "1st", "2nd", "3rd", "4th", "5th", "12th", "42nd",
] as const
const SUFFIXES = [
	"St", "Street", "Ave", "Avenue", "Rd", "Road", "Blvd", "Boulevard", "Ln", "Lane", "Dr", "Drive",
	"Pkwy", "Parkway", "Way", "Ct", "Court", "Pl", "Place", "Cir", "Circle", "Ter", "Terrace", "Hwy",
	"Trail", "Loop", "Cres", "Crescent", "Row", "Walk",
] as const
const DIRECTIONALS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"] as const

// FR street-type prefixes + hyphenated honorific street names (the hyphen is incidental; the boundary
// stress is the prefix↔name split + the number-after-street order).
const FR_PREFIXES = [
	"Rue", "Avenue", "Boulevard", "Place", "Impasse", "Chemin", "Quai", "Cours", "Allée", "Passage",
	"Square", "Villa", "Sentier", "Promenade",
] as const
const FR_NAMES = [
	"Jean-Baptiste Lebas", "Neuve-des-Capucines", "Charles-de-Gaulle", "du Général-Leclerc",
	"de la République", "des Trois-Frères", "Victor-Hugo", "Jean-Jaurès", "de l'Abreuvoir",
	"Émile-Zola", "Gambetta", "Jean-Moulin", "des Martyrs-de-la-Résistance", "du Maréchal-Foch",
	"Pierre-et-Marie-Curie", "Antoine-de-Saint-Exupéry", "de la Liberté", "des Quatre-Vents",
	"du Faubourg-Saint-Antoine", "Saint-Honoré", "de la Pompe", "des Petits-Champs", "Léon-Blum",
	"Aristide-Briand",
] as const
const DE_NAMES = [
	"Konrad-Adenauer-Ufer", "Müller-Breslau-Straße", "Ernst-Reuter-Platz", "Hans-Dietrich-Genscher-Platz",
	"Friedrich-Ebert-Straße", "Rosa-Luxemburg-Straße", "Willy-Brandt-Allee", "Karl-Marx-Straße",
	"Theodor-Heuss-Platz", "Otto-Hahn-Straße", "Max-Planck-Straße", "Robert-Koch-Platz",
	"Heinrich-Heine-Allee", "Sophie-Scholl-Straße", "Albert-Einstein-Ring", "Gottlieb-Daimler-Straße",
	"Käthe-Kollwitz-Ufer", "Bertolt-Brecht-Platz",
] as const

const US_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "Springfield", region: "IL", postcode: "62701", country: "US" },
	{ locality: "Winston-Salem", region: "NC", postcode: "27101", country: "US" },
	{ locality: "Ann Arbor", region: "MI", postcode: "48104", country: "US" },
	{ locality: "Beverly Hills", region: "CA", postcode: "90210", country: "US" },
	{ locality: "Fort Worth", region: "TX", postcode: "76102", country: "US" },
	{ locality: "Grand Prairie", region: "TX", postcode: "75052", country: "US" },
	{ locality: "Coeur d'Alene", region: "ID", postcode: "83814", country: "US" },
	{ locality: "Portland", region: "OR", postcode: "97201", country: "US" },
	{ locality: "Madison", region: "WI", postcode: "53703", country: "US" },
	{ locality: "Boulder", region: "CO", postcode: "80302", country: "US" },
	{ locality: "Savannah", region: "GA", postcode: "31401", country: "US" },
	{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" },
	{ locality: "Santa Fe", region: "NM", postcode: "87501", country: "US" },
	{ locality: "Providence", region: "RI", postcode: "02903", country: "US" },
	{ locality: "Chapel Hill", region: "NC", postcode: "27514", country: "US" },
	{ locality: "Ithaca", region: "NY", postcode: "14850", country: "US" },
	{ locality: "Boise", region: "ID", postcode: "83702", country: "US" },
	{ locality: "Tacoma", region: "WA", postcode: "98402", country: "US" },
	{ locality: "Lincoln", region: "NE", postcode: "68508", country: "US" },
	{ locality: "Asheville", region: "NC", postcode: "28801", country: "US" },
	{ locality: "Flagstaff", region: "AZ", postcode: "86001", country: "US" },
	{ locality: "Bend", region: "OR", postcode: "97701", country: "US" },
	{ locality: "Frederick", region: "MD", postcode: "21701", country: "US" },
	{ locality: "Bloomington", region: "IN", postcode: "47401", country: "US" },
	{ locality: "Athens", region: "GA", postcode: "30601", country: "US" },
	{ locality: "Salem", region: "OR", postcode: "97301", country: "US" },
	{ locality: "Dover", region: "DE", postcode: "19901", country: "US" },
	{ locality: "Bozeman", region: "MT", postcode: "59715", country: "US" },
]
const AU_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "North Sydney", region: "NSW", postcode: "2060", country: "AU" },
	{ locality: "Melbourne", region: "VIC", postcode: "3000", country: "AU" },
	{ locality: "Brisbane", region: "QLD", postcode: "4000", country: "AU" },
	{ locality: "Mosman Park", region: "WA", postcode: "6012", country: "AU" },
	{ locality: "Wollongong", region: "NSW", postcode: "2500", country: "AU" },
	{ locality: "Newcastle", region: "NSW", postcode: "2300", country: "AU" },
	{ locality: "Geelong", region: "VIC", postcode: "3220", country: "AU" },
	{ locality: "Adelaide", region: "SA", postcode: "5000", country: "AU" },
	{ locality: "Hobart", region: "TAS", postcode: "7000", country: "AU" },
	{ locality: "Darwin", region: "NT", postcode: "0800", country: "AU" },
	{ locality: "Cairns", region: "QLD", postcode: "4870", country: "AU" },
	{ locality: "Ballarat", region: "VIC", postcode: "3350", country: "AU" },
	{ locality: "Fremantle", region: "WA", postcode: "6160", country: "AU" },
	{ locality: "Toowoomba", region: "QLD", postcode: "4350", country: "AU" },
]
const FR_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "Roubaix", region: "Hauts-de-France", postcode: "59100", country: "FR" },
	{ locality: "Paris", region: "Île-de-France", postcode: "75014", country: "FR" },
	{ locality: "Toulouse", region: "Occitanie", postcode: "31000", country: "FR" },
	{ locality: "Strasbourg", region: "Grand Est", postcode: "67000", country: "FR" },
	{ locality: "Lyon", region: "Auvergne-Rhône-Alpes", postcode: "69001", country: "FR" },
	{ locality: "Nantes", region: "Pays de la Loire", postcode: "44000", country: "FR" },
	{ locality: "Bordeaux", region: "Nouvelle-Aquitaine", postcode: "33000", country: "FR" },
	{ locality: "Rennes", region: "Bretagne", postcode: "35000", country: "FR" },
	{ locality: "Dijon", region: "Bourgogne-Franche-Comté", postcode: "21000", country: "FR" },
	{ locality: "Montpellier", region: "Occitanie", postcode: "34000", country: "FR" },
	{ locality: "Aix-en-Provence", region: "Provence-Alpes-Côte d'Azur", postcode: "13100", country: "FR" },
	{ locality: "Caen", region: "Normandie", postcode: "14000", country: "FR" },
]
const DE_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "Berlin", region: "Berlin", postcode: "10623", country: "DE" },
	{ locality: "Köln", region: "Nordrhein-Westfalen", postcode: "50668", country: "DE" },
	{ locality: "Heidelberg", region: "Baden-Württemberg", postcode: "69117", country: "DE" },
	{ locality: "München", region: "Bayern", postcode: "80331", country: "DE" },
	{ locality: "Hamburg", region: "Hamburg", postcode: "20095", country: "DE" },
	{ locality: "Dresden", region: "Sachsen", postcode: "01067", country: "DE" },
	{ locality: "Frankfurt", region: "Hessen", postcode: "60311", country: "DE" },
	{ locality: "Leipzig", region: "Sachsen", postcode: "04109", country: "DE" },
	{ locality: "Bremen", region: "Bremen", postcode: "28195", country: "DE" },
	{ locality: "Münster", region: "Nordrhein-Westfalen", postcode: "48143", country: "DE" },
]
// AU/NZ/UK — the unit/street-number slash convention lives here (4/2A = unit 4, number 2A).
const SLASH_TUPLES: ReadonlyArray<BoundaryStressBaseTuple> = [
	{ locality: "North Sydney", region: "NSW", postcode: "2060", country: "AU" },
	{ locality: "Wollongong", region: "NSW", postcode: "2500", country: "AU" },
	{ locality: "Melbourne", region: "VIC", postcode: "3000", country: "AU" },
	{ locality: "Auckland", region: "", postcode: "1011", country: "NZ" },
	{ locality: "Edinburgh", region: "", postcode: "EH2 2BY", country: "GB" },
	{ locality: "Brisbane", region: "QLD", postcode: "4000", country: "AU" },
	{ locality: "Newcastle", region: "NSW", postcode: "2300", country: "AU" },
	{ locality: "Perth", region: "WA", postcode: "6000", country: "AU" },
	{ locality: "Wellington", region: "", postcode: "6011", country: "NZ" },
	{ locality: "Christchurch", region: "", postcode: "8011", country: "NZ" },
	{ locality: "Glasgow", region: "", postcode: "G1 1XW", country: "GB" },
	{ locality: "Manchester", region: "", postcode: "M1 1AE", country: "GB" },
	{ locality: "Bristol", region: "", postcode: "BS1 4DJ", country: "GB" },
	{ locality: "Adelaide", region: "SA", postcode: "5000", country: "AU" },
	{ locality: "Hobart", region: "TAS", postcode: "7000", country: "AU" },
	{ locality: "Canberra", region: "ACT", postcode: "2600", country: "AU" },
]
const UNIT_DESIGNATORS = ["", "", "Unit", "Flat", "Apt", "Suite", "Shop", "Level"] as const

const houseNumber = (random: () => number): string => String(1 + Math.floor(random() * 4999))
const localeFor: Record<string, string> = { US: "en-US", AU: "en-AU", FR: "fr-FR", DE: "de-DE", NZ: "en-NZ", GB: "en-GB" }

const ALL_TEMPLATES: readonly BoundaryStressTemplate[] = [
	"street-eats-affix",
	"comma-less-city-state",
	"fr-prefix",
	"house-number-after-street",
	"au-uk-slash-unit",
]

/**
 * Synthesize one boundary-stress row. `base` is optional — when omitted, a locale-appropriate tuple is
 * drawn from the internal pools (so the generator is self-contained; a build script can pass real
 * tuples for scale + diversity). Every component value is a verbatim substring of `raw`, so `alignRow`
 * locates + BIO-labels it.
 */
export function synthesizeBoundaryStressRow(
	base: BoundaryStressBaseTuple | undefined,
	opts: BoundaryStressSynthesisOpts = {}
): SynthesizedBoundaryStressRow {
	const random = opts.random ?? Math.random
	const template = opts.forceTemplate ?? pick(ALL_TEMPLATES, random)

	if (template === "fr-prefix" || template === "house-number-after-street") {
		const useDe = template === "house-number-after-street" && random() < 0.4
		const b = base ?? pick(useDe ? DE_TUPLES : FR_TUPLES, random)
		const name = useDe ? pick(DE_NAMES, random) : pick(FR_NAMES, random)
		const hn = houseNumber(random)
		if (template === "fr-prefix") {
			const prefix = pick(FR_PREFIXES, random)
			// "{hn} {prefix} {name}, {postcode} {locality}" — postcode-first, prefix split from the name.
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
		// house-number-after-street: "{name} {hn}, {postcode} {locality}" — number FOLLOWS the street.
		const raw = `${name} ${hn}, ${b.postcode} ${b.locality}`
		return {
			raw,
			components: { street: name, house_number: hn, postcode: b.postcode, locality: b.locality },
			locale: localeFor[b.country] ?? "fr-FR",
			template,
		}
	}

	if (template === "au-uk-slash-unit") {
		const b = base ?? pick(SLASH_TUPLES, random)
		const designator = pick(UNIT_DESIGNATORS, random)
		const unitNum = String(1 + Math.floor(random() * 99))
		const houseNum = String(1 + Math.floor(random() * 99)) + (random() < 0.3 ? pick(["A", "B", "C"], random) : "")
		const unit = designator ? `${designator} ${unitNum}` : unitNum
		const name = random() < 0.6 ? pick(SINGLE_STREETS, random) : pick(MULTIWORD_STREETS, random)
		const suffix = pick(SUFFIXES, random)
		// "{unit}/{houseNum} {street} {suffix}, {locality} {region?} {postcode}" — the "/" is what the
		// model must split into unit vs street-number. AU comma-less city/state/postcode tail.
		const tail = b.region ? `${b.locality} ${b.region} ${b.postcode}` : `${b.locality} ${b.postcode}`
		const raw = `${unit}/${houseNum} ${name} ${suffix}, ${tail}`
		return {
			raw,
			components: {
				unit,
				house_number: houseNum,
				street: name,
				street_suffix: suffix,
				locality: b.locality,
				...(b.region ? { region: b.region } : {}),
				postcode: b.postcode,
			},
			locale: localeFor[b.country] ?? "en-AU",
			template,
		}
	}

	// en-US / en-AU street shapes.
	const b = base ?? pick(template === "comma-less-city-state" ? [...US_TUPLES, ...AU_TUPLES] : US_TUPLES, random)
	const hn = houseNumber(random)
	const dir = random() < 0.4 ? pick(DIRECTIONALS, random) : ""
	const name = random() < 0.7 ? pick(MULTIWORD_STREETS, random) : pick(SINGLE_STREETS, random)
	const suffix = pick(SUFFIXES, random)
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
			? // no commas anywhere — the segmentation cue is gone
				`${hn} ${streetCore} ${b.locality} ${b.region} ${b.postcode}`
			: // standard delimited, multi-word street stresses the suffix boundary
				`${hn} ${streetCore}, ${b.locality}, ${b.region} ${b.postcode}`
	return { raw, components, locale: localeFor[b.country] ?? "en-US", template }
}
