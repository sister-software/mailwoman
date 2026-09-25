/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate addresses where a house number, street, venue, locality, region, and postcode co-occur.
 *   This complements no-street examples and preserves house-number signal. Venue names avoid the
 *   adversarial street-like terms used by `no-street.ts`.
 */

/* oxlint-disable mailwoman/prefer-home -- the four admin tails below are hand-written on purpose. the comment at the
   `tail` assignment names the GB surface a layout cannot currently write and the counts behind it. */

import { sample } from "@mailwoman/core/random"

import { countryToLocale } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

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

// #region Venue pool

/**
 * Venue names without street-like terms.
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
	// international/English names at FR addresses, but native forms must appear too —
	// the register mixes both in real Paris data.
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
 * British venue names covering institutional, archaic, branded, and directional-led forms.
 * The held-out gauntlet fixture names are excluded.
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

// #endregion

// #region Fallback street pool

/**
 * Fallback street names for tuples without a street value.
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

// #endregion

// #region House-number generator

function randomHouseNumber(random: () => number): string {
	// Generate a plain numeric house number from 1 to 9999.
	const digits = Math.floor(random() * 4) + 1
	const max = Math.pow(10, digits)
	const n = Math.floor(random() * max) + 1

	return String(n)
}

// #endregion

// #region Synthesis

/**
 * Share of GB rows drawn from the British venue pool.
 */
const GB_VENUE_POOL_RATE = 0.7

/**
 * Share of GB rows with a ranged house number.
 */
const GB_RANGE_NUMBER_RATE = 0.15

/**
 * Share of rows with an explicit trailing country component.
 */
const COUNTRY_APPEND_RATE = 0.3

/**
 * Trailing country surfaces by tuple country.
 *
 * The register mixes formal and short forms where both are common.
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

	// French and British layouts omit region and place postcode differently.
	const frOrder = base.country === "FR"
	const gbOrder = base.country === "GB"
	const veOrder = base.country === "VE"

	// Keep administrative context alongside venue, street, and house-number labels.

	// British rows mix local forms with the shared venue pool.
	const venue = gbOrder && random() < GB_VENUE_POOL_RATE ? sample(GB_VENUES, random) : sample(PLAIN_VENUES, random)
	const street = base.street ?? sample(FALLBACK_STREETS, random)
	let houseNumber = base.houseNumber ?? randomHouseNumber(random)

	// Ranged house numbers are used only in some British examples.
	if (gbOrder && random() < GB_RANGE_NUMBER_RATE && /^\d+$/.test(houseNumber)) {
		const start = Number.parseInt(houseNumber, 10)
		const span = (1 + Math.floor(random() * 4)) * 2

		houseNumber = `${start}-${start + span}`
	}

	// Omit region for France and Great Britain, whose layouts do not render it.
	const components: CanonicalRow["components"] = {
		house_number: houseNumber,
		street,
		venue,
		locality: base.locality,
		...(frOrder || gbOrder ? {} : { region: base.region }),
		postcode: base.postcode,
	}

	// Preserve the recipe's country-specific address tails.
	let tail = frOrder
		? `${base.postcode} ${base.locality}`
		: gbOrder
			? `${base.locality} ${base.postcode}`
			: veOrder
				? `${base.locality} ${base.postcode}, ${base.region}`
				: `${base.locality}, ${base.region} ${base.postcode}`

	// Trailing country surface (Addendum 3): appended after the tail in every order, tagged.
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
 * Interface: every synthesized row carries both house_number and venue
 * (the co-occurrence signal that synth-no-street's distributional shift cost the model).
 *
 * Used by tests + downstream consumers.
 */
export function hasHouseNumberAndVenue(components: CanonicalRow["components"]): boolean {
	return components.house_number !== undefined && components.venue !== undefined
}

// #endregion
