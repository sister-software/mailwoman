/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { matchCountry, matchSubdivision, matchSubdivisionsAnywhere } from "@mailwoman/codex/country"
import { collectNodes, POSTCODE_SHAPE_EXCLUDED_KEY, walkNodes, type AddressNode } from "@mailwoman/core/decoder"
import { acceptPostcode, postcodeSyntax } from "@mailwoman/postcode/country-formats"

/**
 * Whether libaddressinput states a postcode syntax for `country`, so a span can be checked against it.
 */
function statesSyntax(country: string): boolean {
	return postcodeSyntax(country) != null
}

/**
 * Records which postcode spans {@link applyPostcodeShapeCoherence} confirmed, excluded, or abstained on.
 *
 * It also records the countries whose syntax the first confirmed span has.
 */
export interface PostcodeShapeVerdict {
	/**
	 * The upper-case countries whose postcode syntax the first confirmed span has.
	 *
	 * `findPostcodeCountryScope` takes them as its candidates.
	 * The value is `null` when no span was confirmed.
	 */
	narrowing: string[] | null

	/**
	 * Postcode values that have the postcode syntax of a country a sibling country or region span names.
	 */
	confirmed: string[]

	/**
	 * Postcode values that have the postcode syntax of no country the siblings name.
	 */
	excluded: string[]

	/**
	 * Postcode values left undecided because the tree names no country
	 * or region with a stated postcode syntax.
	 */
	abstained: string[]
}

function collectSiblingCountries(roots: readonly AddressNode[]): Set<string> {
	const out = new Set<string>()

	for (const n of walkNodes(roots)) {
		if (n.tag === "country") {
			const matched = matchCountry(n.value)

			if (!matched) {
				// A constituent country such as `England` tagged `country` still fixes its sovereign state.
				const sub = matchSubdivision(n.value)

				if (sub && statesSyntax(sub.country)) {
					out.add(sub.country.toUpperCase())
				}

				continue
			}

			// The match's ISO code is the country, even where it spells a US state abbreviation (`IN`, `DE`, `CA`).
			const country = matched.iso2.toUpperCase()

			if (statesSyntax(country)) {
				out.add(country)
			}

			continue
		}

		if (n.tag === "region") {
			// An abbreviation such as `WA` names a subdivision in more than one country, and each is a candidate.
			for (const sub of matchSubdivisionsAnywhere(n.value)) {
				if (statesSyntax(sub.country)) {
					out.add(sub.country.toUpperCase())
				}
			}

			const hint = n.metadata?.["country_hint"]

			if (typeof hint === "string" && statesSyntax(hint)) {
				out.add(hint.toUpperCase())
			}
		}
	}

	return out
}

/**
 * Checks each postcode span against the libaddressinput postcode syntax of the countries
 * and regions listed in the same tree, without querying a backend.
 *
 * A span that has none of those syntaxes is excluded: it keeps its tag and text and is stamped
 * `postcode_shape_excluded`, which takes it out of the result slots (`isShapeExcludedPostcode`).
 */
export function applyPostcodeShapeCoherence(roots: readonly AddressNode[]): PostcodeShapeVerdict {
	const verdict: PostcodeShapeVerdict = { narrowing: null, confirmed: [], excluded: [], abstained: [] }

	const postcodes = collectNodes(roots, (n) => n.tag === "postcode" && n.value.trim())

	if (!postcodes.length) return verdict

	const siblingCountries = collectSiblingCountries(roots)

	for (const node of postcodes) {
		const code = node.value.trim()
		const intersection = [...siblingCountries].filter((country) => acceptPostcode(code, country) != null)

		if (intersection.length) {
			verdict.confirmed.push(code)

			node.metadata = { ...node.metadata, postcode_shape_countries: intersection }

			if (!verdict.narrowing) {
				verdict.narrowing = intersection
			}

			continue
		}

		if (siblingCountries.size) {
			verdict.excluded.push(code)

			// The span keeps its tag and text, and the stamp takes it out of the result slots.
			// A retag to `house_number` would overwrite the house number the parse already found.
			node.metadata = { ...node.metadata, [POSTCODE_SHAPE_EXCLUDED_KEY]: true }

			continue
		}

		verdict.abstained.push(code)
	}

	return verdict
}
