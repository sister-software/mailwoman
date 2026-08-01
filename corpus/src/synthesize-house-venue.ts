/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   House-number + venue + street co-occurrence synthesizer. The v0.6.3 corrective shard.
 *
 *   The v0.6.2 step-20K diagnostic showed that adding synth-no-street counter-distribution regressed
 *   house_number recall by ~4-5pp. DeepSeek's turn-8 root-cause:
 *
 *   1. Direct: `5th Avenue Theatre`-style adversarial venues teach the model that tokens like "5th"
 *        belong to venues, not house_numbers. (Fixed in `synthesize-no-street.ts` by removing
 *        digit+ordinal venue patterns.)
 *   2. Distributional dilution: synth-no-street adds 122K rows where house_number is absent. The model's
 *        training distribution shifts toward "house_number is rare," and it under-emits the tag at
 *        inference.
 *
 *   This synthesizer fixes #2 directly. Each emitted row has ALL of: house_number, street, venue,
 *   locality, region, postcode — a counter-example to "house_number is rare." Used as a companion
 *   shard to synth-no-street; the v0.6.3 config weights synth-no-street at 0.5 and
 *   synth-house-venue at 1.0 to recover the lost house_number signal.
 *
 *   Real-world shape: business cards, mailing labels, store directories — `"123 Main St, Sunrise
 *   Bakery, Springfield, IL 62701"` is a perfectly ordinary address form.
 *
 *   Venue pool: PLAIN_VENUES from `synthesize-no-street.ts` (re-exported here). Adversarial venues
 *   are deliberately NOT used here — the point is to teach co-occurrence, not to re-introduce
 *   decompose-mode pressure.
 */

import type { CanonicalRow } from "./types.ts"

export interface HouseVenueBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
	street?: string
	houseNumber?: string
}

export type HouseVenueTemplate =
	| "venue-after-street" // "123 Main St, Sunrise Bakery, Springfield, IL 02101"
	| "venue-before-street"

// "Sunrise Bakery, 123 Main St, Springfield, IL 02101"

export interface HouseVenueSynthesisOpts {
	random?: () => number
	forceTemplate?: HouseVenueTemplate
}

export interface SynthesizedHouseVenueRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: HouseVenueTemplate
}

//#region Venue pool

/**
 * PLAIN venue names, carrying no street-typing tokens. This shard teaches house_number + venue coexistence, NOT
 * decompose-mode pressure — adversarial venue names live in `synthesize-no-street.ts`.
 */
const PLAIN_VENUES: ReadonlyArray<string> = [
	"Bob's Pizza",
	"Acme Corporation",
	"Joe's Diner",
	"Sunrise Bakery",
	"Maple Leaf Cafe",
	"Riverside Garden Center",
	"Tech Solutions Inc",
	// FR-flavored venue names (the run-2 contingency): the failing gauntlet fixtures carry
	// international/English names at FR addresses, but native forms must appear too — the register
	// mixes both in real Paris data.
	"Café de la Poste",
	"Boulangerie Saint-Michel",
	"Le Petit Bistrot",
	"Brasserie du Marché",
	"Chez Marcel",
	"La Belle Époque",
	"Restaurant du Port",
	"Pharmacie Centrale",
	"Pacific Industries",
	"Atlantic Holdings",
	"Stellar Consulting",
	"Greenfield Partners",
	"Mountain View Studio",
	"The Daily Grind",
	"Sunset Bistro",
	"Harvest Moon Florist",
	"Iron Forge Brewing",
	"Crescent City Bookstore",
	"Lighthouse Insurance Group",
	"Pinecrest Veterinary",
	"Westwood Realty",
]

/**
 * GB-flavored venue names (#1366): institutional forms (Club/Centre/House/Arms/Station), the "Ye" archaic register, and
 * brand–dash–place compounds — INCLUDING directional-led names, because the target class is venues that open with
 * compass words ("New North Health Centre", "Southfields Station") and the base model reads those as locality/street
 * evidence. The six #1366 gauntlet fixtures' own venue names are deliberately ABSENT — the fixtures stay held-out.
 */
const GB_VENUES: ReadonlyArray<string> = [
	"Ye Olde Cheshire Cheese",
	"Ye Old Mitre",
	"The Red Lion",
	"The Crown & Anchor",
	"The King's Arms",
	"The White Hart",
	"The Royal Oak",
	"North End Road Market",
	"Northfields Community Centre",
	"South Bank Tavern",
	"Southgate Dental Practice",
	"West End Barbers",
	"East Street Pharmacy",
	"New Cross Learning Centre",
	"Old Street Works",
	"Upper Crust - Waterloo",
	"Pret a Manger - Leadenhall",
	"Greggs - Camden High Street",
	"The Ivy - Chelsea Garden",
	"Marks & Spencer Simply Food",
	"Chapel Market Fishmongers",
	"Victoria Coach Station",
	"Highbury Fields Tennis Club",
	"The Carpenters Arms",
	"St Bride's Institute",
	"Albion House",
	"Imperial Dry Cleaners",
	"Golden Dragon 金龍饭店",
]

//#endregion

//#region Fallback street pool

/**
 * Stand-in streets for tuples that carried no `street` field. Plain names, no typing-token ambiguity.
 */
const FALLBACK_STREETS: ReadonlyArray<string> = [
	"Main St",
	"Oak Ave",
	"Pine Rd",
	"Elm Dr",
	"Cedar Ln",
	"Maple Blvd",
	"Birch Ct",
	"Walnut Pl",
	"Cherry Way",
	"Spruce St",
	"Park Ave",
	"Lake Dr",
	"Hill Rd",
	"River Ln",
	"Forest Blvd",
]

//#endregion

//#region House-number generator

function randomHouseNumber(random: () => number): string {
	// Generate a plain numeric house number 1-9999. No fractions/ranges — those land in
	// `data/eval/falsehoods/numbers.jsonl` as known edge cases, not training material.
	const digits = Math.floor(random() * 4) + 1
	const max = Math.pow(10, digits)
	const n = Math.floor(random() * max) + 1

	return String(n)
}

function pick<T>(arr: ReadonlyArray<T>, random: () => number): T {
	return arr[Math.floor(random() * arr.length)]!
}

function countryToLocale(country: string): string {
	switch (country) {
		case "US":
			return "en-US"
		case "CA":
			return "en-CA"
		case "GB":
			return "en-GB"
		case "AU":
			return "en-AU"
		case "FR":
			return "fr-FR"
		case "DE":
			return "de-DE"
		default:
			return "en-US"
	}
}

//#endregion

//#region Synthesis

/**
 * Fraction of GB rows drawing from {@link GB_VENUES} instead of the shared pool. 0.7 mirrors the register mix in real
 * GB listings data (institutional names dominate, international/generic names still appear) — pre-registered in the
 * #1366 memo.
 */
const GB_VENUE_POOL_RATE = 0.7

/**
 * Fraction of GB rows whose house number widens into a range ("287-293"). Real GB venue addresses frequently span
 * buildings; 0.15 keeps ranges a minority register — pre-registered in the #1366 memo.
 */
const GB_RANGE_NUMBER_RATE = 0.15

/**
 * Fraction of rows (EVERY template order) rendered with a trailing country surface, tagged `country`. The 2026-08-01
 * operator probe set proved the mechanism: the FR control row ("…, 75004 Paris, France") fails on a model trained only
 * on country-less venue rows while its country-less twin passes — a trailing country makes the whole template OOD
 * (Addendum 3 of the #1366 pre-registration). 0.3 keeps the country-less register dominant.
 */
const COUNTRY_APPEND_RATE = 0.3

/**
 * Trailing country surfaces by tuple country — the register mixes formal and short forms where both are common.
 */
const COUNTRY_SURFACES: Readonly<Record<string, ReadonlyArray<string>>> = {
	US: ["United States", "USA"],
	GB: ["United Kingdom", "United Kingdom", "United Kingdom", "UK"],
	FR: ["France"],
	CA: ["Canada"],
	AU: ["Australia"],
	DE: ["Germany", "Deutschland"],
}

export function synthesizeHouseVenueRow(
	base: HouseVenueBaseTuple,
	opts: HouseVenueSynthesisOpts = {}
): SynthesizedHouseVenueRow | null {
	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)
	const template = opts.forceTemplate ?? (random() < 0.5 ? "venue-after-street" : "venue-before-street")

	// FR renders postcode-before-locality with NO region ("MR & MRS CRAB, 20 Rue de la Huchette,
	// 75005 Paris" — the v4.0.0 gauntlet's venue-led failure family, the run-2 contingency's exact
	// target shape). GB (#1366) renders locality-then-postcode with NO region and NO comma between
	// them ("Ye Three Lords, 27 Minories, London EC3N 1DE" — the third tail the shard must teach).
	// Every other country keeps the original US-order tail.
	const frOrder = base.country === "FR"
	const gbOrder = base.country === "GB"

	// GB rows draw from the GB pool 70% of the time (institutional/archaic/brand-dash-place forms,
	// incl. directional-led names — the #1366 target class) and the shared pool otherwise; real GB
	// registers mix both. Other locales keep the shared pool (which already carries the FR flavor).
	const venue = gbOrder && random() < GB_VENUE_POOL_RATE ? pick(GB_VENUES, random) : pick(PLAIN_VENUES, random)
	const street = base.street ?? pick(FALLBACK_STREETS, random)
	let houseNumber = base.houseNumber ?? randomHouseNumber(random)

	// GB range numbers ("287-293 New N Rd"): real GB venue addresses frequently span buildings.
	// 15% of GB rows widen the number into a range (same parity, small span — the register's real
	// shape). Pre-registered in the #1366 memo; the base pool's no-ranges stance stays for other
	// locales.
	if (gbOrder && random() < GB_RANGE_NUMBER_RATE && /^\d+$/.test(houseNumber)) {
		const start = Number.parseInt(houseNumber, 10)
		const span = (1 + Math.floor(random() * 4)) * 2

		houseNumber = `${start}-${start + span}`
	}

	const components: CanonicalRow["components"] = {
		house_number: houseNumber,
		street,
		venue,
		locality: base.locality,
		...(frOrder || gbOrder ? {} : { region: base.region }),
		postcode: base.postcode,
	}

	let tail = frOrder
		? `${base.postcode} ${base.locality}`
		: gbOrder
			? `${base.locality} ${base.postcode}`
			: `${base.locality}, ${base.region} ${base.postcode}`

	// Trailing country surface (Addendum 3): appended AFTER the tail in every order, tagged.
	const countrySurfaces = COUNTRY_SURFACES[base.country]

	if (countrySurfaces && random() < COUNTRY_APPEND_RATE) {
		const countrySurface = pick(countrySurfaces, random)
		components.country = countrySurface
		tail = `${tail}, ${countrySurface}`
	}

	let raw: string

	switch (template) {
		case "venue-after-street":
			raw = `${houseNumber} ${street}, ${venue}, ${tail}`
			break
		case "venue-before-street":
			raw = `${venue}, ${houseNumber} ${street}, ${tail}`
			break
	}

	return { raw, components, locale, template }
}

/**
 * Contract: every synthesized row carries BOTH house_number AND venue (the co-occurrence signal that synth-no-street's
 * distributional shift cost the model). Used by tests + downstream consumers.
 */
export function hasHouseNumberAndVenue(components: CanonicalRow["components"]): boolean {
	return components.house_number !== undefined && components.venue !== undefined
}

//#endregion
