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
import { writersPrintRegionBesideLayout } from "@mailwoman/codex/address/layouts"
import type { ComponentDict } from "@mailwoman/codex/address/render"
import type { ComponentTag } from "@mailwoman/codex/component"
import { hashFNV1a } from "@mailwoman/core/coarse-placer/fnv-hash"
import { mulberry32 } from "@mailwoman/core/math/random"

/**
 * A number in [0, 1) read from `salt`, `country` and `components`, so a rebuild draws the same number for a row.
 *
 * The key joins the sorted tags and values with the separators `stableSourceID` uses.
 */
function rowDraw(salt: string, country: string, components: ComponentDict): number {
	const payload = (Object.keys(components) as ComponentTag[])
		.toSorted()
		.map((tag) => `${tag}=${components[tag] ?? ""}`)
		.join("\u001F")

	return mulberry32(hashFNV1a(`${salt}\u001E${country.toUpperCase()}\u001E${payload}`))()
}

/**
 * The number in [0, 1) that picks a row's printed forms.
 */
function corpusFormDraw(country: string, components: ComponentDict): number {
	return rowDraw("postcode-form", country, components)
}

/**
 * The share of corpus rows that print a region their postal layout leaves out, after the
 * locality, in a country whose writers print it (`writersPrintRegionBesideLayout`).
 *
 * The postal layouts of Argentina, Romania, Lithuania and others omit the region
 * because the operator's examples don't print it.
 * Writers in those countries print it, as in `6400 Trenque Lauquen, Buenos Aires`.
 *
 * Half the rows keep the operator's form, and half keep the region and its label.
 */
export const REGION_AFTER_LOCALITY_SHARE = 0.5

/**
 * The number in [0, 1) that decides whether a row prints a region its layout leaves out.
 *
 * It reads the same key as {@linkcode corpusFormDraw} under its own salt, so the two draws are independent.
 */
function regionDraw(country: string, components: ComponentDict): number {
	return rowDraw("region-after-locality", country, components)
}

/**
 * {@linkcode formatAddressRow} for a corpus row: each slot with documented forms prints the
 * one {@linkcode corpusFormDraw} picks for the row, and a region the layout leaves out prints
 * after the locality on {@linkcode REGION_AFTER_LOCALITY_SHARE} of rows that hold one.
 */
export function formatCorpusRow(
	components: ComponentDict,
	country: string,
	opts: Omit<FormatAddressOptions, "formDraw" | "regionAfterLocality"> = {}
): AddressRow | null {
	return formatAddressRow(components, country, {
		...opts,
		formDraw: corpusFormDraw(country, components),
		regionAfterLocality:
			Boolean(components.region) &&
			writersPrintRegionBesideLayout(country, opts.script ?? undefined) &&
			regionDraw(country, components) < REGION_AFTER_LOCALITY_SHARE,
	})
}
