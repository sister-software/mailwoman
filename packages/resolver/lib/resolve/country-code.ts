/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads a country written as a code of three or more capitals: `USA`, `RUS`, `RMI`.
 *
 *   Two-letter codes stay out, because `CA`, `IN` and `LA` are also regions and cities.
 */

import { COUNTRY_ABBREVIATIONS, matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { countryDisplayNames } from "@mailwoman/codex/country/display-names"
import { firstNodeWhere, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"

import { decorateNode } from "#decorate-node"

const ABBREVIATIONS: ReadonlySet<string> = new Set(Object.values(COUNTRY_ABBREVIATIONS).flat())

/**
 * Returns the alpha-2 code of a country written as a code, or null for any other text.
 */
export function writtenCountryCode(written: string): string | null {
	const value = written.trim()

	if (!/^[\p{Lu}.]{3,}$/u.test(value) || matchSubdivision(value)) return null

	return matchCountry(value)?.iso2 ?? null
}

/**
 * Reads a region written as a country abbreviation as the country, so the walk is scoped to that country.
 *
 * `Anal Island, Likiep Atoll, RMI` parses `RMI` as a region.
 * The parse stays unchanged for the caller, so the change applies to a copy of the tree.
 *
 * An ISO code stays a region here, because `Fort Wayne, IND` and `Denver, COL` abbreviate US states.
 */
export function readRegionCodeAsCountry(tree: AddressTree): AddressTree {
	const isCountry = (node: AddressNode) => node.tag === "country"
	const isCode = (node: AddressNode) => node.tag === "region" && ABBREVIATIONS.has(node.value.trim())

	if (firstNodeWhere(tree.roots, isCountry) || !firstNodeWhere(tree.roots, isCode)) return tree

	const copy = structuredClone(tree)

	firstNodeWhere(copy.roots, isCode)!.tag = "country"

	return copy
}

/**
 * Answers an input that is only a country code with that country, ahead of any reading the parse gave it.
 */
export async function applyCountryCode(roots: AddressNode[], raw: string, backend: ResolverBackend): Promise<void> {
	const written = raw.trim()
	const iso2 = writtenCountryCode(written)

	if (!iso2) return

	// The gazetteer does not hold every code, so the country's English names follow the written form.
	for (const text of [written, ...countryDisplayNames(iso2, ["en"])]) {
		const places = await backend.findPlace({ text, placetype: "country", country: iso2 })
		const place = places.find((candidate) => candidate.country === iso2)

		if (!place) continue

		const node: AddressNode = {
			tag: "country",
			value: written,
			start: 0,
			end: written.length,
			confidence: 1,
			children: [],
		}

		decorateNode(node, place, [])
		roots.splice(0, roots.length, node)

		return
	}
}
