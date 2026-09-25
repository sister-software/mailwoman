/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { candidateSystemsForPostcode, SYSTEM_CODES } from "@mailwoman/codex"
import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { isUSStateAbbreviation } from "@mailwoman/codex/us"
import { collectNodes, walkNodes, type AddressNode } from "@mailwoman/core/decoder"

const SYSTEM_UNIVERSE: ReadonlySet<string> = new Set<string>(SYSTEM_CODES.map((system) => system.toUpperCase()))

/**
 * Records which postcode spans {@link applyPostcodeShapeCoherence} confirmed, excluded
 * or abstained on, and the postcode systems of the first confirmed span.
 */
export interface PostcodeShapeVerdict {
	/**
	 * The upper-case postcode systems of the first confirmed span, passed to
	 * `findPostcodeCountryScope` as its candidate systems; `undefined` when no span was confirmed.
	 */
	narrowing?: string[]

	/**
	 * Postcode values whose shape fits a system named by a sibling country or region span.
	 */
	confirmed: string[]

	/**
	 * Postcode values whose shape fits none of the systems the siblings name.
	 */
	excluded: string[]

	/**
	 * Postcode values left undecided because they match no known postcode shape
	 * or the tree names no country or region.
	 */
	abstained: string[]
}

function collectSiblingSystems(roots: readonly AddressNode[]): Set<string> {
	const out = new Set<string>()

	for (const n of walkNodes(roots)) {
		if (n.tag === "country") {
			const matched = matchCountry(n.value)

			if (!matched) continue

			const system = isUSStateAbbreviation(matched.iso2) ? "US" : matched.iso2.toUpperCase()

			if (SYSTEM_UNIVERSE.has(system)) {
				out.add(system)
			}

			continue
		}

		if (n.tag === "region") {
			const sub = matchSubdivision(n.value)

			if (sub && SYSTEM_UNIVERSE.has(sub.country.toUpperCase())) {
				out.add(sub.country.toUpperCase())
			}

			const hint = n.metadata?.["country_hint"]

			if (typeof hint === "string" && SYSTEM_UNIVERSE.has(hint.toUpperCase())) {
				out.add(hint.toUpperCase())
			}
		}
	}

	return out
}

/**
 * Checks each postcode span's shape against the postcode systems of the countries
 * and regions named in the same tree, without querying a backend.
 *
 * A span that fits none of those systems is excluded: an all-digit span is retagged
 * `house_number`, and any other span is stamped `postcode_shape_excluded`.
 */
export function applyPostcodeShapeCoherence(roots: readonly AddressNode[]): PostcodeShapeVerdict {
	const verdict: PostcodeShapeVerdict = { confirmed: [], excluded: [], abstained: [] }

	const postcodes = collectNodes(roots, (n) => n.tag === "postcode" && n.value.trim())

	if (!postcodes.length) return verdict

	const siblingSystems = collectSiblingSystems(roots)

	for (const node of postcodes) {
		const code = node.value.trim()
		const systems = candidateSystemsForPostcode(code)

		if (!systems.length) {
			verdict.abstained.push(code)

			continue
		}

		const intersection = systems.map((system) => system.toUpperCase()).filter((system) => siblingSystems.has(system))

		if (intersection.length) {
			verdict.confirmed.push(code)

			node.metadata = { ...node.metadata, postcode_shape_systems: intersection }

			if (verdict.narrowing === undefined) {
				verdict.narrowing = intersection
			}

			continue
		}

		if (siblingSystems.size) {
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
 * Returns true for a postcode span that shape coherence excluded but could not retag,
 * which every postcode consumer in the resolver must skip.
 */
export function isShapeExcludedPostcode(node: AddressNode): boolean {
	return node.tag === "postcode" && node.metadata?.["postcode_shape_excluded"] === true
}
