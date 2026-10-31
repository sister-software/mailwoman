/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The region codes a country's addresses write in place of the region's name, from Google libaddressinput.
 *
 *   A libaddressinput country spec lists its subdivisions twice: `sub_keys`, the value an address writes, and
 *   `sub_names`, the subdivision's name. The United States keys `NY` and names `New York`, so its addresses write
 *   `NY`. France lists no subdivisions and Japan keys each prefecture by its name, so neither has a code to write.
 *   A country counts as writing codes when most of its keys differ from their names: AU, BR, CA, ES, HK, IT, KR, MX,
 *   SO and US in the vendored specs.
 */

import { readLocalTextFileSync } from "@mailwoman/core/fs/readers"
import { isFileSync } from "@mailwoman/core/fs/readers/stat"
import { tryParsingJSON } from "@mailwoman/core/json"
import { sslAddressSpecsPath } from "@mailwoman/dictionaries/paths"

/**
 * The fields of a libaddressinput country spec this module reads.
 */
interface SubdivisionSpec {
	sub_keys?: string
	sub_names?: string
	sub_lnames?: string
}

const CODES_BY_COUNTRY = new Map<string, ReadonlyMap<string, string>>()

/**
 * Reads one country's name-to-code map, or an empty map when the country writes no codes.
 */
function codesFor(country: string): ReadonlyMap<string, string> {
	const cached = CODES_BY_COUNTRY.get(country)

	if (cached) return cached

	const codes = new Map<string, string>()
	const path = sslAddressSpecsPath()(`${country}.json`)
	// `variantsFor` runs synchronously inside the row generator, so the spec is read synchronously, once per country.
	const spec = isFileSync(path) ? tryParsingJSON<SubdivisionSpec>(readLocalTextFileSync(path)) : null
	const keys = spec?.sub_keys?.split("~") ?? []

	for (const names of [spec?.sub_names, spec?.sub_lnames]) {
		const values = names?.split("~") ?? []
		const differing = values.filter((name, i) => keys[i] && name !== keys[i]).length

		// A country whose keys are its names writes the name, so it has no code to substitute.
		if (values.length !== keys.length || differing * 2 <= keys.length) continue

		for (const [i, name] of values.entries()) {
			if (name !== keys[i]) {
				codes.set(name.toLowerCase(), keys[i]!)
			}
		}
	}

	CODES_BY_COUNTRY.set(country, codes)

	return codes
}

/**
 * The code `country`'s addresses use for the region `regionName`, or `null` when they write the name.
 */
export function regionCodeFor(country: string, regionName: string): string | null {
	return codesFor(country.toUpperCase()).get(regionName.toLowerCase()) ?? null
}
