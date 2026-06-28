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

import type { CanonicalRow } from "./types.js"

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
	| "venue-before-street" // "Sunrise Bakery, 123 Main St, Springfield, IL 02101"

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

// ---------------------------------------------------------------------------------------------
// Venue pool — PLAIN, no street-typing tokens. The point of this shard is to teach
// house_number + venue coexistence, NOT to re-introduce decompose-mode pressure.
// Adversarial venue names live in `synthesize-no-street.ts`.
// ---------------------------------------------------------------------------------------------

const PLAIN_VENUES: ReadonlyArray<string> = [
	"Bob's Pizza",
	"Acme Corporation",
	"Joe's Diner",
	"Sunrise Bakery",
	"Maple Leaf Cafe",
	"Riverside Garden Center",
	"Tech Solutions Inc",
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

// ---------------------------------------------------------------------------------------------
// Fallback street pool for tuples that didn't carry a `street` field. Plain street names
// without typing-token ambiguity.
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// House-number generator
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------------------------

export function synthesizeHouseVenueRow(
	base: HouseVenueBaseTuple,
	opts: HouseVenueSynthesisOpts = {}
): SynthesizedHouseVenueRow | null {
	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)
	const template = opts.forceTemplate ?? (random() < 0.5 ? "venue-after-street" : "venue-before-street")

	const venue = pick(PLAIN_VENUES, random)
	const street = base.street ?? pick(FALLBACK_STREETS, random)
	const houseNumber = base.houseNumber ?? randomHouseNumber(random)

	const components: CanonicalRow["components"] = {
		house_number: houseNumber,
		street,
		venue,
		locality: base.locality,
		region: base.region,
		postcode: base.postcode,
	}

	let raw: string

	switch (template) {
		case "venue-after-street":
			raw = `${houseNumber} ${street}, ${venue}, ${base.locality}, ${base.region} ${base.postcode}`
			break
		case "venue-before-street":
			raw = `${venue}, ${houseNumber} ${street}, ${base.locality}, ${base.region} ${base.postcode}`
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
