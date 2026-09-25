/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates addresses in which a house number, a street and a venue appear together.
 */

/* oxlint-disable mailwoman/prefer-home -- the four admin tails below are hand-written per country on purpose. */

import { sample } from "@mailwoman/core/random"

import { countryToLocale } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

/**
 * The address context for one row.
 * The synthesizer fills a missing street or house number.
 */
export interface HouseVenueBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
	street?: string
	houseNumber?: string
}

/**
 * Whether the venue follows the street, as in `123 Main St, Sunrise Bakery, …`, or precedes it.
 */
export type HouseVenueTemplate = "venue-after-street" | "venue-before-street"

/**
 * Options for {@link synthesizeHouseVenueRow}.
 */
export interface HouseVenueSynthesisOpts {
	random?: () => number
	forceTemplate?: HouseVenueTemplate
}

/**
 * One synthesized row with its template.
 */
export interface SynthesizedHouseVenueRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: HouseVenueTemplate
}

// #region Venue pool

// Venue names in this pool avoid street-like words.
const PLAIN_VENUES: ReadonlyArray<string> = [
	"Bob's Pizza",
	"Acme Corporation",
	"Joe's Diner",
	"Sunrise Bakery",
	"Maple Leaf Cafe",
	"Riverside Garden Center",
	"Tech Solutions Inc",
	// French addresses carry both English and French venue names, so the pool includes both.
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

// This pool must exclude the venue names in the held-out gauntlet fixtures.
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

// #endregion

// #region Fallback street pool

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

// #endregion

// #region House-number generator

function randomHouseNumber(random: () => number): string {
	// Each digit count from one to four is equally likely.
	const digits = Math.floor(random() * 4) + 1
	const max = Math.pow(10, digits)
	const n = Math.floor(random() * max) + 1

	return String(n)
}

// #endregion

// #region Synthesis

const GB_VENUE_POOL_RATE = 0.7

const GB_RANGE_NUMBER_RATE = 0.15

const COUNTRY_APPEND_RATE = 0.3

// Repeated entries weight the sample toward the more common form.
const COUNTRY_SURFACES: Readonly<Record<string, ReadonlyArray<string>>> = {
	US: ["United States", "USA"],
	GB: ["United Kingdom", "United Kingdom", "United Kingdom", "UK"],
	FR: ["France"],
	CA: ["Canada"],
	AU: ["Australia"],
	DE: ["Germany", "Deutschland"],
}

/**
 * Synthesizes one row with a house number, a street, a venue and the tuple's locality and postcode.
 *
 * GB rows sometimes use British venue names and ranged house numbers.
 * FR and GB rows omit the region.
 */
export function synthesizeHouseVenueRow(
	base: HouseVenueBaseTuple,
	opts: HouseVenueSynthesisOpts = {}
): SynthesizedHouseVenueRow | null {
	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)
	const template = opts.forceTemplate ?? (random() < 0.5 ? "venue-after-street" : "venue-before-street")

	const frOrder = base.country === "FR"
	const gbOrder = base.country === "GB"
	const veOrder = base.country === "VE"

	const venue = gbOrder && random() < GB_VENUE_POOL_RATE ? sample(GB_VENUES, random) : sample(PLAIN_VENUES, random)
	const street = base.street ?? sample(FALLBACK_STREETS, random)
	let houseNumber = base.houseNumber ?? randomHouseNumber(random)

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
			: veOrder
				? `${base.locality} ${base.postcode}, ${base.region}`
				: `${base.locality}, ${base.region} ${base.postcode}`

	const countrySurfaces = COUNTRY_SURFACES[base.country]

	if (countrySurfaces && random() < COUNTRY_APPEND_RATE) {
		const countrySurface = sample(countrySurfaces, random)
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
 * Reports whether the components include both `house_number` and `venue`,
 * which every row from this synthesizer does.
 */
export function hasHouseNumberAndVenue(components: CanonicalRow["components"]): boolean {
	return components.house_number !== undefined && components.venue !== undefined
}

// #endregion
