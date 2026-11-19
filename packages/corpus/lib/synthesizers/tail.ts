// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders the admin tail of a synthesized row through the country's codex address layout,
 *   so a synthesizer writes `Chicago, IL 60613`, `75005 Paris`, `London, EC3N 1DE`
 *   or `Maracaibo 4001, Zulia` from one call rather than from a template per country.
 *
 *   The layout decides which parts print: the FR layout prints no region,
 *   so a FR tail holds none and the returned components say so.
 *   The lines the layout writes are joined with the country's line join.
 *
 *   The result is the one-line form the corpus rows take.
 *   A caller that passes its seeded draw also gets the written orders the codex
 *   records beside the postal one.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { lineJoinForCountry, WRITTEN_LAYOUTS, writtenLayoutForCountry } from "@mailwoman/codex/address/layouts"
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
export interface RenderedTail {
	raw: string
	components: ComponentDict
}

/**
 * Options for {@link layoutAdminTail}.
 */
export interface AdminTailOptions {
	/**
	 * The synthesizer's seeded draw.
	 *
	 * Given one, a country that records written orders beside its postal layout
	 * (`WRITTEN_LAYOUTS` in `@mailwoman/codex/address/layouts`) renders the mix those orders' shares state.
	 * The draw is taken only for such a country, so every other country's rows keep their stream.
	 * Without one, every row takes the postal layout.
	 */
	random?: () => number
}

/**
 * Renders the admin parts through the layout of `country`, or returns `null`
 * when the codex has no layout for the country or the layout prints none of the parts.
 */
export function layoutAdminTail(
	country: string,
	parts: AdminTailParts,
	opts: AdminTailOptions = {}
): RenderedTail | null {
	const components: ComponentDict = {}

	for (const [tag, value] of Object.entries(parts) as Array<[keyof AdminTailParts, string | undefined]>) {
		if (value?.trim()) {
			components[tag] = value
		}
	}

	const code = country.trim().toUpperCase()
	const layout = opts.random && WRITTEN_LAYOUTS[code] ? writtenLayoutForCountry(code, opts.random()) : null
	const row = formatAddressRow(components, country, layout ? { layout } : {})

	if (!row || !row.raw.trim()) return null

	return { raw: row.raw.replaceAll("\n", lineJoinForCountry(country)), components: row.components }
}
