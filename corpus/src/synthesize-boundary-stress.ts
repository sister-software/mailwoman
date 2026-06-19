/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Boundary-instability synthesizer (#375 — the highest-leverage parser lever). The failure taxonomy
 *   + the within-token-punctuation decomposition (#702) found one failure FAMILY surfacing under
 *   many names: the model mis-places token boundaries between adjacent components when the boundary
 *   is ambiguous or unmarked. This generator emits diverse BIO-labeled rows that put the gold
 *   boundary exactly where the model wobbles, so a retrain learns the boundary from context, not
 *   the lexeme.
 *
 *   The four token-aligned stress shapes, all in BASE LOCALES (US/FR/DE) so the shard never
 *   introduces tokens the base corpus lacks (the #511 base-consistency lint flagged an earlier
 *   AU-bearing draft: AU 4-digit postcodes collide with US house numbers, and AU localities are
 *   absent from the US/FR/DE base — a real contradiction). Each component is a whitespace-separated
 *   token run, so `alignRow` labels it cleanly:
 *
 *   1. `street-eats-affix` — multi-word street + suffix (`Country Club Rd` → street + street_suffix),
 *        the #1 wobble: the model keeps the suffix in the street.
 *   2. `comma-less-city-state` — no comma between street / locality / region (`100 Main St Springfield
 *        IL 62701`), the #694 family: concatenated input loses the segmentation cue. US-only (US
 *        zips are base-consistent; the boundary is locale-agnostic).
 *   3. `fr-prefix` — FR street-type prefix split from the name (`Rue Jean-Baptiste Lebas` →
 *        street_prefix
 *
 *        - Street), postcode-first order.
 *   4. `house-number-after-street` — FR/DE number-follows-street (`Neuve-des-Capucines 5` → street +
 *        house_number), the model absorbs the number into the street.
 *
 *   Two BALANCING shapes (added 2026-06-18 after the v1.6.0 probes). The first pass at weight 1.0
 *   lifted the boundaries but over-fit a NARROW distribution — every row was a clean, full,
 *   structured address — so the model regressed on out-of-distribution real rows (held-out US
 *   locality 66.3→58.2%). These two widen the distribution the shard teaches over, per the
 *   diagnosis (scripts/eval/locality-regression-probe): 5. `bare-locality` — locality with NO
 *   street (`Public Library, Lisbon ND`, `75003 Paris`), the ship-blocker: 84% of the v1.6.0
 *   locality regression was DROPPED locality on bare "City, STATE" rows, because every other shape
 *   placed a street before the city. Bare / comma-less / postcode'd / venue-prefixed forms, US +
 *   FR. 6. `house-number-before-street` — the confounding mirror of #4 (same FR vocab, number
 *   BEFORE the street). A balanced before:after mix breaks the positional shortcut behind the #4
 *   order-bias.
 *
 *   EXCLUDED: the region+postcode glue (`NY14201` — sub-token, no punctuation to split) and the
 *   AU/NZ/UK slash unit-convention (`4/2A` → unit+house_number). The slash labels cleanly (the
 *   tokenizer splits `/`) and is the worst within-token class — but it inherently requires non-base
 *   AU/NZ/UK locales, which contradict the US/FR/DE base (the lint catch). It belongs in a
 *   separately-scoped AU/NZ/UK boundary-coverage shard that ALSO adds AU base coverage, not in this
 *   base-locale shard. `synthesize-boundary-stress.test.ts` proves the alignments.
 */

import type { CanonicalRow } from "./types.js"

export type BoundaryStressTemplate =
	| "street-eats-affix"
	| "comma-less-city-state"
	| "fr-prefix"
	| "house-number-after-street"
	// Added 2026-06-18 after the v1.6.0 probes (the shard's NARROW distribution over-fit "full structured
	// address" and regressed OOD). These two re-balance the contexts the model actually sees:
	| "bare-locality" // the ship-blocker fix: locality with NO street (the 84%-dropped "City, STATE" rows)
	| "house-number-before-street" // the confounding mirror of house-number-after-street (number position)

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
	"Queens Gate",
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
const DIRECTIONALS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"] as const

// FR street-type prefixes + hyphenated honorific street names (the hyphen is incidental; the boundary
// stress is the prefix↔name split + the number-after-street order).
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

// Org/venue prefixes for the bare-locality shape — the v1.6.0 locality drop hit org-PREFIXED real rows
// hardest ("LISBON PUBLIC LIBRARY, …, Lisbon ND"; "Alburg Health Center"). Teaching the locality WITH a
// leading venue keeps the model emitting it on facility-style addresses (NPPES/HRSA shapes). `venue` is a
// base ComponentTag.
//
// #511-LINTED 2026-06-18 (scripts/lint-venue-vocab — scan of nppes/hrsa/tiger/nad/wof-admin): every token
// here is venue-DOMINANT in the base, so the shard agrees with it. The first draft was naive — 9 terms
// were dropped because their tokens are dominantly street/locality and would CONTRADICT the base the way
// Madison-as-street did (#511): "Fire" 93% street, "Veterans" 94% street, "City" 68% locality, "Hall" 63%
// street, "Memorial"/"Hospital" 62-63% street, "Recreation" 79% street, "Town" 48% locality, "Library" 51%
// street, "County" 68% street, "Arts"/"Courthouse"/"Municipal" dependent_locality. Kept tokens: Clinic 98%,
// Practice 98%, Dental 100%, Health 99%, Medical 88%, Community 92%, Department 90%, Group 87%, Center 65%,
// School 70%, Public 89%, Elementary/Family 97% (all venue).
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

// Localities DERIVED from the base corpus (#511): every name here is verified locality-DOMINANT in the
// training data (B-locality ≫ I-street), so the shard agrees with the base instead of fighting it. The
// night's targeted scan caught the prior vocab (Madison, Portland, Springfield IL…) at 92–100% STREET
// in the base ("Madison Ave"), the "5th Avenue Theatre" #511 trap. See 2026-06-17-locality-vocab-fix.
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
// FR localities DERIVED from the FR (ban) shards specifically — where these famous cities are 95–99%
// locality-DOMINANT (Paris 515605/24789, Marseille 247014/1752, Lyon 106239/3114). NB: the all-shard
// scan falsely flagged them street-dominant by undersampling the FR block (parts 180–209) and mixing in
// US street-contexts; the FR-block scan is the honest distribution. Dept-diverse (28 depts), region
// empty (French addresses carry no region token; the generator's region-optional path handles it).
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
// NB: no DE_TUPLES — German cities are street-dominated too ("Berliner Straße"), and the base yielded
// zero locality-dominant DE towns in the scan, so house-number-after-street is FR-only here. DE's
// native-order number-after-street is covered by the dedicated synth-german shard.
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
 * Synthesize one boundary-stress row. `base` is optional — when omitted, a locale-appropriate tuple
 * is drawn from the internal pools (so the generator is self-contained; a build script can pass
 * real tuples for scale + diversity). Every component value is a verbatim substring of `raw`, so
 * `alignRow` locates + BIO-labels it.
 */
export function synthesizeBoundaryStressRow(
	base: BoundaryStressBaseTuple | undefined,
	opts: BoundaryStressSynthesisOpts = {}
): SynthesizedBoundaryStressRow {
	const random = opts.random ?? Math.random
	const template = opts.forceTemplate ?? pick(ALL_TEMPLATES, random)

	if (template === "bare-locality") {
		// The v1.6.0 ship-blocker fix: locality was DROPPED on bare/short "City, STATE" rows (84% of the
		// regression) because every prior shape placed a street before the city, so the model learned "the
		// city follows a street" and stopped emitting locality without one. Teach the locality with NO street,
		// across the forms real data carries it — bare, comma-LESS, postcode'd, and venue/org-prefixed.
		const b = base ?? (random() < 0.3 ? pick(FR_TUPLES, random) : pick(US_TUPLES, random))
		const venue = random() < 0.45 ? pick(VENUES, random) : ""
		// ~12% carry a trailing country token — the v1.7.1 country patch (DeepSeek 2026-06-18). The pure
		// "City, STATE" bare rows carry NO country token, which cost ~4pp on us.country_homograph in v1.7.0;
		// teaching "…, USA"/"…, France" recovers it as a single-variable additive without diluting locality.
		const withCountry = random() < 0.12
		if (b.country === "FR") {
			// FR carries no region token; "{postcode} {locality}" is the bare FR form.
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
		const comma = random() < 0.6 ? "," : "" // include the comma-LESS "City STATE" form too
		// "United States" (United 98% / States 98% country in the base), NOT "USA" — the #511 lint found
		// "USA" is locality-DOMINANT (75%, only 6% country) in the base; labeling it country would contradict.
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
		// FR-only (no base-consistent DE locality vocab; see the DE_TUPLES note above).
		const b = base ?? pick(FR_TUPLES, random)
		const name = pick(FR_NAMES, random)
		const hn = houseNumber(random)
		if (template === "house-number-before-street") {
			// The confounding MIRROR of house-number-after-street: the SAME FR street vocab with the number
			// BEFORE the name. A balanced before:after mix (the build/recipe sets the ratio, ~7:3 to keep US
			// house_number 99.8% safe) teaches the model a street-adjacent number is a house_number by FORM,
			// not position — the probe found v1.6.0 confidently absorbs the TRAILING number into street (I-street
			// P=0.96), the order-bias.
			const raw = `${hn} ${name}, ${b.postcode} ${b.locality}`
			return {
				raw,
				components: { house_number: hn, street: name, postcode: b.postcode, locality: b.locality },
				locale: localeFor[b.country] ?? "fr-FR",
				template,
			}
		}
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

	// en-US street shapes (street-eats-affix + comma-less). US-only — US zips are base-consistent and
	// the boundary these teach is locale-agnostic; no need to introduce a non-base locale.
	const b = base ?? pick(US_TUPLES, random)
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
