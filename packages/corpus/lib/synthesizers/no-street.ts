/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   No-street address synthesizer — the counter-distribution that v0.6.1's synth-street source is
 *   missing. Generates BIO-labelable rows where there is no street, no house_number, no
 *   street_prefix, no street_suffix, no intersection — only some subset of {venue, locality,
 *   region, postcode, country}.
 *
 *   Rationale: the [2026-05-28 night-2
 *   postmortem](../../docs/articles/evals/night-shifts/2026-05-28-night-2-postmortem.md) and the [layer-1
 *   eval](../../docs/articles/evals/experiments/2026-05-28-layer-1-morphology-fst.md) showed that synth-street
 *   pushed the model into a high-confidence "decompose mode" that leaked into `dependent_locality`.
 *   Per DeepSeek's turn-2 recipe, the model needs explicit counter-examples: addresses where the
 *   model should not emit street labels. This synthesizer is that source.
 *
 *   Six row templates, each producing a {raw, components} pair with no street-side tags:
 *
 *   1. **Plain venue + locality + region + postcode** `"Bob's Pizza, Boston, MA 02101"`
 *   2. **Adversarial venue (containing street-typing words)** `"Wall Street Industries, NY 10005"`,
 *        `"5th Avenue Theater, Seattle, WA"`, `"Highway 61 Diner, Memphis TN"`. These are the rows
 *        that v0.6.1's decompose-mode would mis-tag as street_prefix/suffix; explicit negative
 *        training kills that signal.
 *   3. **Locality + region + postcode (minimal)** — `"Boston, MA 02101"`
 *   4. **Locality + region** — `"Boston, MA"`
 *   5. **Postcode-only** — `"02101"`
 *   6. **Country-only** — `"United States"`, `"France"` (rare in real data, but the model has seen these
 *        and should not hallucinate streets on them).
 *
 *   Output is a `CanonicalRow` with no street-side components. Alignment will produce BIO labels
 *   where every token is one of {`B-venue`, `I-venue`, `B-locality`, `I-locality`, `B-region`,
 *   `B-postcode`, `B-country`, `I-country`, `O`} — explicitly never any street tag. That is the
 *   counter-example signal the model is missing.
 *
 *   This complements (does not replace) the existing US-base-tuple source used by
 *   `po-box.ts`; the same `NoStreetBaseTuple` shape is consumed.
 */

import { type ComponentDict, formatAddressRow } from "@mailwoman/codex/address-format"
import { countryCodeForTable } from "@mailwoman/codex/country"
import { sample } from "@mailwoman/core/random"

import { countryToLocale } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

//#region Types

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs, not thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
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

//#endregion

//#region Venue name pools

/**
 * Plain venue names — businesses without street-typing words in the name. Used as the easy-mode positive class for
 * venue detection.
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
 * Adversarial venue names — businesses whose names contain street-typing tokens (Avenue, Street, Highway, Lane, Drive,
 * Court, Plaza, Park, ...) but are themselves venues, not streets. The model must learn that these are venues despite
 * the street-typing tokens.
 *
 * **No leading digit+ordinal venues** (e.g. "5th Avenue Theatre", "7th Street Bistro"). The v0.6.2 2026-05-29 step-20K
 * eval showed that synthesized rows starting with `<digits><ordinal>` confused the model about house_number recognition
 * — tokens like "5th" (which should be `B-house_number` in real addresses) were being labeled `B-venue` because
 * adversarial venues placed them in venue position. v0.6.3 omits these patterns; the `synth-house-venue` source
 * separately teaches that house_number and venue coexist.
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

// Compile-time guard: every venue must not start with the digit+ordinal pattern that
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

//#endregion

//#region Synthesis

/**
 * Generate one no-street counter-example row for a base (locality, region, postcode, country) tuple. Picks a template
 * by weighted random; the venue templates are the critical counter-distribution against synth-street's decompose-mode
 * pressure.
 */
export function synthesizeNoStreetRow(
	base: NoStreetBaseTuple,
	opts: NoStreetSynthesisOpts = {}
): SynthesizedNoStreetRow | null {
	const random = opts.random ?? Math.random
	const locale = countryToLocale(base.country)

	const template: NoStreetTemplate = opts.forceTemplate ?? pickTemplate(random)

	// A tuple's `country` is whatever its source wrote — `ES`, `ESP` or `Spain` — and a layout is keyed by the alpha-2
	// code.
	const iso2 = countryCodeForTable(base.country)

	if (!iso2) return null

	/**
	 * Write `extra` on top of the base tuple's admin components through the country's own layout.
	 *
	 * The layout decides the order, the separators and which components it has a slot for, and reports the subset it
	 * PRINTED. France absorbs the region into its postcode line, so a row that emitted `region` regardless would carry a
	 * label whose text is not in `raw`, and the aligner would have nothing to attach it to.
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
			// The venue-adversarial template name is descriptive — when selected, this branch
			// always draws from the adversarial pool. The `adversarialVenueRatio` opt is what
			// the OUTER template picker uses to bias toward this template versus the plain one;
			// once we're inside this branch the choice is already made.
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
 * Template weights chosen so that the venue-* templates dominate (they're the counter-example shape that matters), with
 * the minimal templates as long-tail noise.
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
 * Convenience: assert at type-level that a synthesized row carries no street-side components. Used by tests +
 * downstream consumers who want to verify the contract at runtime.
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

//#endregion
