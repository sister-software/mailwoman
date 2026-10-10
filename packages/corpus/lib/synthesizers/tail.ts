/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders the admin tail of a synthesized row through the country's codex address layout, so a
 *   synthesizer writes `Chicago, IL 60613`, `75005 Paris`, `London, EC3N 1DE` or
 *   `Maracaibo 4001, Zulia` from one call rather than from a template per country.
 *
 *   The layout decides which parts print: the FR layout prints no region, so a FR tail carries none
 *   and the returned components say so. The lines the layout writes are joined with the country's
 *   line join, which is the one-line form the corpus rows take.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { lineJoinForCountry } from "@mailwoman/codex/address/layouts"
import type { ComponentDict } from "@mailwoman/codex/address/render"

/**
 * The admin parts a synthesizer has for a row.
 */
export interface AdminTailParts {
	locality?: string
	region?: string
	postcode?: string
	country?: string
}

/**
 * A rendered tail and the parts the layout printed, with the caller's values.
 */
export interface AdminTail {
	raw: string
	components: ComponentDict
}

/**
 * Renders the admin parts through the layout of `country`, or returns `null`
 * when the codex has no layout for the country or the layout prints none of the parts.
 */
export function renderAdminTail(country: string, parts: AdminTailParts): AdminTail | null {
	const components: ComponentDict = {}

	for (const [tag, value] of Object.entries(parts) as Array<[keyof AdminTailParts, string | undefined]>) {
		if (value?.trim()) {
			components[tag] = value
		}
	}

	const row = formatAddressRow(components, country)

	if (!row || !row.raw.trim()) return null

	return { raw: row.raw.replaceAll("\n", lineJoinForCountry(country)), components: row.components }
}
