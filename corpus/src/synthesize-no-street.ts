/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   No-street address synthesizer — the counter-distribution that v0.6.1's synth-street shard is
 *   missing. Generates BIO-labelable rows where there is NO street, NO house_number, NO
 *   street_prefix, NO street_suffix, NO intersection — only some subset of {venue, locality,
 *   region, postcode, country}.
 *
 *   Rationale: the [2026-05-28 night-2 postmortem](../../docs/articles/evals/2026-05-28-night-2-postmortem.md)
 *   and the [layer-1 eval](../../docs/articles/evals/2026-05-28-layer-1-morphology-fst.md) showed
 *   that synth-street pushed the model into a high-confidence "decompose mode" that leaked into
 *   `dependent_locality`. Per DeepSeek's turn-2 recipe, the model needs explicit counter-examples:
 *   addresses where the model should NOT emit street labels. This synthesizer is that source.
 *
 *   Six row templates, each producing a {raw, components} pair with no street-side tags:
 *
 *   1. **Plain venue + locality + region + postcode**
 *      `"Bob's Pizza, Boston, MA 02101"`
 *   2. **Adversarial venue (containing street-typing words)**
 *      `"Wall Street Industries, NY 10005"`, `"5th Avenue Theater, Seattle, WA"`,
 *      `"Highway 61 Diner, Memphis TN"`. These are the rows that v0.6.1's decompose-mode
 *      would mis-tag as street_prefix/suffix; explicit negative training kills that signal.
 *   3. **Locality + region + postcode (minimal)** — `"Boston, MA 02101"`
 *   4. **Locality + region** — `"Boston, MA"`
 *   5. **Postcode-only** — `"02101"`
 *   6. **Country-only** — `"United States"`, `"France"` (rare in real data, but the model has
 *      seen these and should not hallucinate streets on them).
 *
 *   Output is a `CanonicalRow` with no street-side components. Alignment will produce BIO labels
 *   where every token is one of {`B-venue`, `I-venue`, `B-locality`, `I-locality`, `B-region`,
 *   `B-postcode`, `B-country`, `I-country`, `O`} — explicitly never any street tag. That IS the
 *   counter-example signal the model is missing.
 *
 *   This complements (does not replace) the existing US-base-tuple source used by
 *   `synthesize-po-box.ts`; the same `NoStreetBaseTuple` shape is consumed.
 */

import type { CanonicalRow } from "./types.js"

// -------------------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------------------

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
	/** Override the template selection entirely (used by tests for deterministic coverage). */
	forceTemplate?: NoStreetTemplate
}

export interface SynthesizedNoStreetRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: NoStreetTemplate
}

// -------------------------------------------------------------------------------------------------
// Venue name pools
// -------------------------------------------------------------------------------------------------

/**
 * Plain venue names — businesses without street-typing words in the name. Used as the
 * easy-mode positive class for venue detection.
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
 * Adversarial venue names — businesses whose names contain street-typing tokens (Avenue,
 * Street, Highway, Lane, Drive, Court, Plaza, Park, ...) but are themselves venues, not streets.
 * The model must learn that these are venues despite the street-typing tokens.
 *
 * **No leading digit+ordinal venues** (e.g. "5th Avenue Theatre", "7th Street Bistro"). The
 * v0.6.2 2026-05-29 step-20K eval showed that synthesized rows starting with
 * `<digits><ordinal>` confused the model about house_number recognition — tokens like "5th"
 * (which should be `B-house_number` in real addresses) were being labeled `B-venue` because
 * adversarial venues placed them in venue position. v0.6.3 omits these patterns; the
 * `synth-house-venue` shard separately teaches that house_number and venue coexist.
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

// Compile-time guard: every venue must NOT start with the digit+ordinal pattern that
// confuses house_number recognition. If a future contributor adds a "5th Avenue Theatre"-
// style entry, this assertion will fire at module load time.
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

// -------------------------------------------------------------------------------------------------
// Synthesis
// -------------------------------------------------------------------------------------------------

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

/**
 * Generate one no-street counter-example row for a base (locality, region, postcode, country)
 * tuple. Picks a template by weighted random; the venue templates are the load-bearing
 * counter-distribution against synth-street's decompose-mode pressure.
 */
export function synthesizeNoStreetRow(
	base: NoStreetBaseTuple,
	opts: NoStreetSynthesisOpts = {}
): SynthesizedNoStreetRow | null {
	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)

	const template: NoStreetTemplate = opts.forceTemplate ?? pickTemplate(random)

	switch (template) {
		case "venue-plain": {
			const venue = pick(PLAIN_VENUES, random)
			const raw = `${venue}, ${base.locality}, ${base.region} ${base.postcode}`
			return {
				raw,
				components: {
					venue,
					locality: base.locality,
					region: base.region,
					postcode: base.postcode,
				},
				locale,
				template,
			}
		}
		case "venue-adversarial": {
			// The venue-adversarial template name is descriptive — when selected, this branch
			// always draws from the adversarial pool. The `adversarialVenueRatio` opt is what
			// the OUTER template picker uses to bias toward this template versus the plain one;
			// once we're inside this branch the choice is already made.
			const venue = pick(ADVERSARIAL_VENUES, random)
			const raw = `${venue}, ${base.locality}, ${base.region} ${base.postcode}`
			return {
				raw,
				components: {
					venue,
					locality: base.locality,
					region: base.region,
					postcode: base.postcode,
				},
				locale,
				template,
			}
		}
		case "locality-region-postcode": {
			const raw = `${base.locality}, ${base.region} ${base.postcode}`
			return {
				raw,
				components: {
					locality: base.locality,
					region: base.region,
					postcode: base.postcode,
				},
				locale,
				template,
			}
		}
		case "locality-region": {
			const raw = `${base.locality}, ${base.region}`
			return {
				raw,
				components: {
					locality: base.locality,
					region: base.region,
				},
				locale,
				template,
			}
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
			const country = pick(names, random)
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
 * Template weights chosen so that the venue-* templates dominate (they're the counter-example
 * shape that matters), with the minimal templates as long-tail noise.
 */
function pickTemplate(random: () => number): NoStreetTemplate {
	const r = random()
	if (r < 0.35) return "venue-adversarial" // 35% — the load-bearing slice
	if (r < 0.6) return "venue-plain" // 25%
	if (r < 0.8) return "locality-region-postcode" // 20%
	if (r < 0.92) return "locality-region" // 12%
	if (r < 0.98) return "postcode-only" // 6%
	return "country-only" // 2%
}

/**
 * Convenience: assert at type-level that a synthesized row carries no street-side components.
 * Used by tests + downstream consumers who want to verify the contract at runtime.
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
