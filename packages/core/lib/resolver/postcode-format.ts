/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which countries a postcode's format is consistent with.
 *
 * `@mailwoman/codex/postcode/shapes` owns the character patterns, including the anchored forms this
 * module tests. What belongs here is the policy on top of them: which shapes are distinctive enough
 * across all jurisdictions to stand as country evidence, and in which calling context.
 *
 * That split matters because the two questions have different answers. Codex's `candidateSystemsForPostcode`
 * asks which of its ten address systems accept a string, so a shape unique among those ten still reveals
 * little about the other 240 jurisdictions. The tables below are a narrower claim, each entry verified
 * as non-overlapping, and they stay narrow deliberately.
 *
 * `@mailwoman/resolver` runs in the browser through the demo cascade, so this module derives the
 * implied country set rather than relying on a CLI caller to pass it in. Codex is pure data and adds
 * no platform dependency. `geocode-core` re-exports these functions for its consumers and tests.
 */

import { wholePostcodeShape } from "@mailwoman/codex/postcode/shapes"

/**
 * Shapes that identify a country unambiguously, by their codex label.
 *
 * They are a stronger signal than the language-based coarse placer.
 * That placer conflates GB and US and routes some GB addresses to US namesakes.
 * Letters-first formats never match a US ZIP.
 *
 * Extend this list only with a shape verified as non-overlapping across jurisdictions,
 * rather than as unique among the address systems codex happens to implement.
 *
 * NL's `\d{4} [A-Z]{2}` is deliberately absent: a US house number plus a directional
 * fragment (`1234 NE`) matches it exactly, and this list feeds `recognizeBarePostcode`,
 * which must never read a street name as a postcode.
 * NL appears in {@linkcode countriesFromPostcodeFormat} instead.
 */
const SINGLE_COUNTRY_SHAPE_LABELS: ReadonlyArray<readonly [label: string, country: string]> = [
	// GB `E4 9AZ` — letters-first, ending `\d[A-Z]{2}` and never matching a US ZIP / NL / FR / CA code.
	["GB", "GB"],
	// CA `K2P 1L4` — `A#A #A#`, ending `\d[A-Z]\d`, distinct from GB's `\d[A-Z]{2}`.
	["CA", "CA"],
	// IE Eircode `D02 AF30` is a routing key plus a 4-alnum unique part.
	// That part separates it from GB's 3-character `\d[A-Z]{2}` inward.
	// Belfast `BT1 5GS` stays GB, because Northern Ireland uses GB postcodes.
	["IE", "IE"],
]

/**
 * The compiled form of {@linkcode SINGLE_COUNTRY_SHAPE_LABELS}, resolved once at module load.
 *
 * A label this module states and codex does not define therefore throws on first import,
 * where resolving per call would instead let that label refuse every postcode it was meant to accept.
 */
const SINGLE_COUNTRY_SHAPES: ReadonlyArray<readonly [re: RegExp, country: string]> = SINGLE_COUNTRY_SHAPE_LABELS.map(
	([label, country]) => [wholePostcodeShape(label), country]
)

/**
 * The country a parsed postcode's format implies, or null.
 */
export function countryFromPostcodeFormat(postcode: string | undefined): string | null {
	const p = postcode?.trim()

	if (!p) return null

	for (const [re, country] of SINGLE_COUNTRY_SHAPES) if (re.test(p)) return country

	return null
}

/**
 * Spaced `NNN NN`, which CZ and SK share, and which SE and GR share with them.
 *
 * Unlike the shapes in {@linkcode SINGLE_COUNTRY_SHAPE_LABELS}, it implies a set,
 * so it can check a locale-inferred scope and cannot identify one country.
 *
 * It stays here rather than in codex because codex's shape table feeds postcode repair
 * and the trainer's anchor painting, where a new row changes what those paint.
 * This pattern has no consumer on that path.
 */
const SHARED_NNN_NN = /^\d{3} \d{2}$/

/**
 * NL PC6 `1012 LG` — digits-first then two letters, read through codex's NL shape.
 *
 * It is NL-unique as a postcode shape and too forgeable for {@linkcode SINGLE_COUNTRY_SHAPE_LABELS},
 * so it belongs only here, where every consumer checks on a tree that is already a bare postcode.
 */
const NL_PC6: RegExp = wholePostcodeShape("NL")

/**
 * Returns each country consistent with the parsed postcode format.
 *
 * The function checks the single-country shapes, then the NL PC6 shape, then the shared `NNN NN` family.
 *
 * It returns an empty list when the shape implies no country, such as a bare
 * five-digit format that US, FR, DE and others share.
 * Such an input stays with the locale prior on purpose.
 *
 * Unlike {@linkcode countryFromPostcodeFormat} this is not an unforgeable-in-any-context
 * claim, so a consumer applies it only to a tree that is a bare postcode, where the
 * street-fragment collision the single-country list must exclude cannot arise.
 */
export function countriesFromPostcodeFormat(postcode: string | undefined): readonly string[] {
	const p = postcode?.trim()

	if (!p) return []

	const single = countryFromPostcodeFormat(p)

	if (single) return [single]

	if (NL_PC6.test(p)) return ["NL"]

	if (SHARED_NNN_NN.test(p)) return ["CZ", "SK", "SE", "GR"]

	return []
}
