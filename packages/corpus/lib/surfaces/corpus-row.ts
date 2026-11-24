// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Renders a corpus row through its country's layout, printing each form the postal
 *   operator documents for a value in that form's share of rows.
 *
 *   Croatia's operator prints `HR-10000 ZAGREB` on mail from abroad,
 *   and the bare `10000 ZAGREB` is its domestic form.
 *   The layout's slot lists both, and the parser reads both, so the corpus writes both.
 *
 *   The form is drawn from the row's identity, its country and its components,
 *   so a rebuild renders every row in the form it rendered before, and the draw
 *   takes no number from a recipe's seeded stream.
 */

import { formatAddressRow, type AddressRow, type FormatAddressOptions } from "@mailwoman/codex/address/format"
import type { ComponentDict } from "@mailwoman/codex/address/render"
import type { ComponentTag } from "@mailwoman/codex/component"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { mulberry32 } from "@mailwoman/core/math/random"

/**
 * The number in [0, 1) that picks a row's printed forms, read from `country` and `components`.
 *
 * The key joins the sorted tags and values with the separators `stableSourceID` uses.
 */
function corpusFormDraw(country: string, components: ComponentDict): number {
	const payload = (Object.keys(components) as ComponentTag[])
		.toSorted()
		.map((tag) => `${tag}=${components[tag] ?? ""}`)
		.join("\u001F")

	return mulberry32(hashFNV1a(`postcode-form\u001E${country.toUpperCase()}\u001E${payload}`))()
}

/**
 * {@linkcode formatAddressRow} for a corpus row: each slot with documented forms
 * prints the one {@linkcode corpusFormDraw} picks for the row.
 */
export function formatCorpusRow(
	components: ComponentDict,
	country: string,
	opts: Omit<FormatAddressOptions, "formDraw"> = {}
): AddressRow | null {
	return formatAddressRow(components, country, { ...opts, formDraw: corpusFormDraw(country, components) })
}
