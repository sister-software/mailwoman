// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Generates addresses in which a house number, a street and a venue appear together.
 */

import { countryRenderForms } from "@mailwoman/codex/country"
import { sample } from "@mailwoman/core/math/random"

import { layoutAdminTail } from "#synthesizers/tail"
import { countryToLocale } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

/**
 * The address context for one row.
 *
 * The synthesizer draws a missing house number and refuses a tuple without a street.
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
	// French addresses include both English and French venue names, so the pool includes both.
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

/**
 * The share of rows that write the venue after the street, as a typed query does.
 *
 * An example of that order is `23 St Aelreds Way, The Royal Oak, York`.
 * The postal operators print the building or business name above the thoroughfare
 * (Royal Mail: `Victoria House / 15 The Street`), so the venue-first order is the majority.
 */
const VENUE_AFTER_STREET_SHARE = 0.25

const GB_VENUE_POOL_RATE = 0.7

const GB_RANGE_NUMBER_RATE = 0.15

/**
 * The share of rows that end in the country, written in one of `countryRenderForms`.
 */
const COUNTRY_APPEND_RATE = 0.3

/**
 * Synthesizes one row with a house number, a street, a venue and the tuple's admin tail.
 *
 * The row renders through the country's codex layout.
 * A country with no layout yields `null`, and so does a tuple without a street of its own.
 *
 * A drawn street would write one language's vocabulary into another country's address,
 * as `8 Pine Rd, Le Petit Bistrot, Srikakulam` did.
 *
 * GB rows sometimes use British venue names and ranged house numbers.
 */
export function synthesizeHouseVenueRow(
	base: HouseVenueBaseTuple,
	opts: HouseVenueSynthesisOpts = {}
): SynthesizedHouseVenueRow | null {
	const street = base.street?.trim()

	if (!street) return null

	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)

	const template =
		opts.forceTemplate ?? (random() < VENUE_AFTER_STREET_SHARE ? "venue-after-street" : "venue-before-street")

	// country-branch: the British venue pool and the ranged house number are GB English data.
	// A per-country venue pool from the Overture names file would replace the branch.
	const gbPools = base.country === "GB"

	const venue = gbPools && random() < GB_VENUE_POOL_RATE ? sample(GB_VENUES, random) : sample(PLAIN_VENUES, random)
	let houseNumber = base.houseNumber ?? randomHouseNumber(random)

	if (gbPools && random() < GB_RANGE_NUMBER_RATE && /^\d+$/.test(houseNumber)) {
		const start = Number.parseInt(houseNumber, 10)
		const span = (1 + Math.floor(random() * 4)) * 2

		houseNumber = `${start}-${start + span}`
	}

	const countrySurfaces = countryRenderForms(base.country)

	const countrySurface =
		countrySurfaces.length && random() < COUNTRY_APPEND_RATE ? sample(countrySurfaces, random) : undefined

	// The layout decides the tail's order and which parts it prints: FR prints no region,
	// VE keeps the region after the postcode, GB puts the postcode after the locality.
	// A country with written orders beside its postal one, such as IN, renders a mix of them.
	const tail = layoutAdminTail(
		base.country,
		{
			locality: base.locality,
			region: base.region,
			postcode: base.postcode,
			country: countrySurface,
		},
		{ random }
	)

	if (!tail) return null

	const components: CanonicalRow["components"] = {
		house_number: houseNumber,
		street,
		venue,
		...tail.components,
	}

	let raw: string

	switch (template) {
		case "venue-after-street":
			raw = `${houseNumber} ${street}, ${venue}, ${tail.raw}`
			break
		case "venue-before-street":
			raw = `${venue}, ${houseNumber} ${street}, ${tail.raw}`
			break
	}

	return { raw, components, locale, template }
}

/**
 * Reports whether the components include both `house_number` and `venue`,
 * which every row from this synthesizer does.
 */
export function hasHouseNumberAndVenue(components: CanonicalRow["components"]): boolean {
	return Boolean(components.house_number && components.venue)
}

// #endregion
