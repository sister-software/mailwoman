/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { isUSStateAbbreviation } from "@mailwoman/codex/us"
import { collectNodes, walkNodes, type AddressNode } from "@mailwoman/core/decoder"
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

			const country = isUSStateAbbreviation(matched.iso2) ? "US" : matched.iso2.toUpperCase()

			if (statesSyntax(country)) {
				out.add(country)
			}

			continue
		}

		if (n.tag === "region") {
			const sub = matchSubdivision(n.value)

			if (sub && statesSyntax(sub.country)) {
				out.add(sub.country.toUpperCase())
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
 * A span that has none of those syntaxes is excluded: an all-digit span is retagged
 * `house_number`, and any other span is stamped `postcode_shape_excluded`.
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

			if (/^\d+$/.test(code)) {
				node.tag = "house_number"
			} else {
				node.metadata = { ...node.metadata, postcode_shape_excluded: true }
			}

			continue
		}

		verdict.abstained.push(code)
	}

	return verdict
}

/**
 * Returns true for a postcode span excluded by shape coherence when it could not be retagged.
 *
 * Every postcode consumer in the resolver must skip that span.
 */
export function isShapeExcludedPostcode(node: AddressNode): boolean {
	return node.tag === "postcode" && node.metadata?.["postcode_shape_excluded"] === true
}
