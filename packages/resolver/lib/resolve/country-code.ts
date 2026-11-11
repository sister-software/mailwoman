/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads a country written as a code of three or more capitals: `USA`, `RUS`, `RMI`.
 *
 *   Two-letter codes stay out, because `CA`, `IN` and `LA` are also regions and cities.
 *
 *   The codes a country claims are its ISO 3166-1 alpha-3 code and the abbreviations the codex curates:
 *   `COUNTRY_ABBREVIATIONS` (`UAE`, `PNG`, `RMI`) and the capitalized entries of `COUNTRY_SURFACE_FORMS` (`GER`, `ROM`).
 *   With the ISO codes as the only claimed set, `UAE` would read as Mount Aue, an aerodrome in Papua New Guinea with
 *   one Wikipedia edition, because IATA assigns that code too. The abbreviation table records what a country's own users write, and a code
 *   written for a country is read as that country wherever it is written: as a whole input here, and as a region in
 *   `readRegionCodeAsCountry`.
 *
 *   A code a country claims answers the country ahead of any airport holding the same IATA code. Of the 249 alpha-3
 *   codes, 191 are also an airport's code in Wikidata's P238 file: `AUS` (Austin–Bergstrom), `FRA` (Frankfurt), `HND`
 *   (Tokyo Haneda), `USA` (Concord Regional). `applyLandmark` lists that airport as the country's alternative. A code
 *   no country claims answers the airport: `SFO`, `LHR`, `DTW`.
 */

import { COUNTRY_ABBREVIATIONS, matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { countryDisplayNames } from "@mailwoman/codex/country/display-names"
import { firstNodeWhere, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { ResolverBackend } from "@mailwoman/core/resolver"

import { decorateNode } from "#decorate-node"

const ABBREVIATIONS: ReadonlySet<string> = new Set(Object.values(COUNTRY_ABBREVIATIONS).flat())

/**
 * Returns the alpha-2 code of a country written as a code, or null for any other text.
 *
 * The text has to be the whole code in capitals, three or more characters, and not a subdivision code.
 * `AUS`, `HND` and `UAE` are countries.
 * `SFO`, `Aus` and `IN` are not.
 *
 * The codex holds the ISO 3166-1 alpha-3 codes and the curated abbreviations.
 * The registry's country records stay out of this module, because they'd add 51
 * KB to every browser bundle that holds the resolver.
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
 * Answers an input that's only a country code with that country, ahead of any reading the parse gave it.
 */
export async function applyCountryCode(roots: AddressNode[], raw: string, backend: ResolverBackend): Promise<void> {
	const written = raw.trim()
	const iso2 = writtenCountryCode(written)

	if (!iso2) return

	// The gazetteer doesn't hold every code, so the country's English names follow the written form.
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
