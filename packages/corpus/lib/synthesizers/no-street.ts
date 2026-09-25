/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate addresses without street components as counterexamples for street-heavy training data.
 *   Templates cover venues, localities, postcodes, and countries, including venue names that contain
 *   street-like words. Output components never include street-side tags.
 */

import { type ComponentDict, formatAddressRow } from "@mailwoman/codex/address-format"
import { countryCodeForTable } from "@mailwoman/codex/country"
import { sample } from "@mailwoman/core/random"

import { countryToLocale } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

// #region Types

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs rather than thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
   output distribution, and reading the cascade top-to-bottom is how you see it. Naming each cutoff
   would hide the distribution behind a wall of identifiers. Genuine thresholds in these files are
   extracted as named constants above. */

export interface NoStreetBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

export type NoStreetTemplate =
	| "venue-plain"
	| "venue-adversarial"
	| "locality-region-postcode"
	| "locality-region"
	| "postcode-only"
	| "country-only"

export interface NoStreetSynthesisOpts {
	random?: () => number
	/**
	 * Override the template selection entirely (used by tests for deterministic coverage).
	 */
	forceTemplate?: NoStreetTemplate
}

export interface SynthesizedNoStreetRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: NoStreetTemplate
}

// #endregion

// #region Venue name pools

/**
 * Venue names without street-like words.
 */
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

/**
 * Venue names containing street-like words.
 *
 * Avoid leading digit-plus-ordinal forms, which can confuse house-number labels;
 * `synth-house-venue` covers house-number and venue co-occurrence.
 */
const ADVERSARIAL_VENUES: ReadonlyArray<string> = [
	"Wall Street Industries",
	"Highway 61 Diner",
	"Lane Bryant",
	"Park Avenue Dental",
	"Broadway Theatre Company",
	"Madison Square Garden",
	"Main Street Bakery",
	"Sunset Boulevard Studios",
	"Ocean Drive Cafe",
	"Mountain Road Outfitters",
	"Hollywood Boulevard Salon",
	"East Bay Auto",
	"West End Pharmacy",
	"North Shore Insurance",
	"South Park Children's Center",
	"River Road Animal Hospital",
	"Hill Street Blues Bar",
	"Court House Square Realty",
	"Plaza Hotel",
	"Lincoln Park Zoo",
	"Central Park Conservancy",
	"Lakeshore Boulevard Apartments",
	"Memorial Drive Medical Center",
	"Wabash Avenue Press",
	"State Street Bank",
	"Market Street Grill",
	"Beach Boulevard Diner",
	"Garden Lane Florist",
]

// Compile-time guard: every venue must not start with the digit+ordinal pattern
// that confuses house_number recognition.
// If a future contributor adds a "5th Avenue Theatre"- style entry,
// this assertion will fire at module load time.
for (const v of ADVERSARIAL_VENUES) {
	if (/^\d+(st|nd|rd|th)\b/i.test(v)) {
		throw new Error(
			`ADVERSARIAL_VENUES entry "${v}" starts with digit+ordinal; this pattern confuses ` +
				`house_number recognition (see v0.6.3 eval doc). Use a non-numeric venue name.`
		)
	}
}

const COUNTRY_NAMES = new Map<string, ReadonlyArray<string>>([
	["US", ["United States", "USA", "U.S.A.", "United States of America"]],
	["FR", ["France"]],
	["DE", ["Germany", "Deutschland"]],
	["GB", ["United Kingdom", "UK", "Great Britain"]],
	["CA", ["Canada"]],
	["AU", ["Australia"]],
])

// #endregion

// #region Synthesis

/**
 * Generate one no-street row from a base locality, region, postcode, and country.
 */
export function synthesizeNoStreetRow(
	base: NoStreetBaseTuple,
	opts: NoStreetSynthesisOpts = {}
): SynthesizedNoStreetRow | null {
	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)

	const template: NoStreetTemplate = opts.forceTemplate ?? pickTemplate(random)

	// Address layouts are keyed by ISO alpha-2 codes.
	const iso2 = countryCodeForTable(base.country)

	if (!iso2) return null

	/**
	 * Render components with the country's address layout and return only fields present in the output.
	 */
	const render = (
		extra: ComponentDict,
		carry: { locality?: boolean; region?: boolean; postcode?: boolean }
	): SynthesizedNoStreetRow | null => {
		const dict: ComponentDict = { ...extra }

		if (carry.locality && base.locality) {
			dict.locality = base.locality
		}

		if (carry.region && base.region?.trim()) {
			dict.region = base.region
		}

		if (carry.postcode && base.postcode) {
			dict.postcode = base.postcode
		}

		const rendered = formatAddressRow(dict, iso2, { singleLine: true })

		if (!rendered) return null

		return { raw: rendered.raw, components: rendered.components, locale, template }
	}

	switch (template) {
		case "venue-plain": {
			return render({ venue: sample(PLAIN_VENUES, random) }, { locality: true, region: true, postcode: true })
		}
		case "venue-adversarial": {
			// The template picker already selected the adversarial venue form.
			return render({ venue: sample(ADVERSARIAL_VENUES, random) }, { locality: true, region: true, postcode: true })
		}
		case "locality-region-postcode": {
			return render({}, { locality: true, region: true, postcode: true })
		}
		case "locality-region": {
			return render({}, { locality: true, region: true })
		}
		case "postcode-only": {
			return {
				raw: base.postcode,
				components: { postcode: base.postcode },
				locale,
				template,
			}
		}
		case "country-only": {
			const names = COUNTRY_NAMES.get(base.country) ?? [base.country]
			const country = sample(names, random)

			return {
				raw: country,
				components: { country },
				locale,
				template,
			}
		}
	}
}

/**
 * Select a template, favoring venue examples over minimal address forms.
 */
function pickTemplate(random: () => number): NoStreetTemplate {
	const r = random()

	if (r < 0.35) return "venue-adversarial"

	// 35% — the critical pattern
	if (r < 0.6) return "venue-plain"

	// 25%
	if (r < 0.8) return "locality-region-postcode"

	// 20%
	if (r < 0.92) return "locality-region"

	// 12%
	if (r < 0.98) return "postcode-only"

	// 6%
	return "country-only" // 2%
}

/**
 * Convenience: assert at type-level that a synthesized row carries no street-side components.
 *
 * Used by tests + downstream consumers who want to check the interface behavior at runtime.
 */
export const STREET_SIDE_TAGS = [
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"house_number",
	"intersection_a",
	"intersection_b",
	"unit",
] as const

export function hasAnyStreetSideTag(components: CanonicalRow["components"]): boolean {
	for (const t of STREET_SIDE_TAGS) {
		if (components[t]) return true
	}

	return false
}

// #endregion
