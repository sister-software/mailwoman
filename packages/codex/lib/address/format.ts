/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a `ComponentTag`-keyed dict into a country-localized string — the inverse of the parser.
 *
 *   The order lives in `@mailwoman/codex/address-layouts`, as data. This module is the public surface over
 *   {@linkcode renderAddress}: {@linkcode formatAddress} is the join, and {@linkcode formatAddressRow} is the join plus
 *   the tags the layout printed, which is what every corpus adapter actually wants.
 *
 *   IT USED TO WRAP A THIRD-PARTY ENGINE, and 229 of this file's 438 lines existed to work around templates written
 *   against OpenStreetMap's tag vocabulary rather than this project's: a pass that parsed 295 mustache templates at
 *   module load to discover which of them could render a sub-locality, a second that spliced a missing line back in
 *   afterwards, a third that removed a connector the template wrote between two slots when one was empty, and a
 *   translation layer between the two vocabularies. Owning the layouts deletes all four — a layout that declares a
 *   `dependent_locality` slot needs no interrogation about whether it has one, and a line assembled from present values
 *   never writes a connector around an absent one.
 */

import { layoutForCountry, lineJoinForCountry } from "#address/layouts/index"
import { joinRendering, renderAddress, type ComponentDict } from "#address/render"
import type { ComponentTag } from "#component"

export type { ComponentDict } from "#address/render"

/**
 * Options accepted by {@linkcode formatAddress} and {@linkcode formatAddressRow}.
 */
export interface FormatAddressOptions {
	/**
	 * Replace the layout's line breaks with this separator. Default `"\n"`: the envelope form.
	 */
	separator?: string

	/**
	 * Join the lines the way the COUNTRY does, for the single-line form a query or a corpus row takes — `", "` for most,
	 * `" "` for Japan and Korea, and nothing at all for the Chinese-script systems, whose admin run is unseparated.
	 *
	 * It is an option rather than each caller's literal because the literal is wrong outside the anglophone systems:
	 * joining Japan's lines with a comma gives `1-9-1, 丸の内, 千代田区, 東京都 100-0005`, which is the romanized convention
	 * printed backwards. `separator` wins when both are given.
	 */
	singleLine?: boolean
}

function separatorFor(country: string, opts: FormatAddressOptions): string {
	if (opts.separator !== undefined) return opts.separator

	return opts.singleLine ? lineJoinForCountry(country) : "\n"
}

/**
 * Render a component dict into an idiomatic per-country address string.
 *
 * Returns an empty string when the dict is empty, and when no layout names `country` — 55 of the 252 shipped country
 * records carry no usable skeleton, and answering nothing for one of those reports absence rather than inventing an
 * order. Throws nothing; a partial dict degrades to the parts the layout can print.
 */
export function formatAddress(components: ComponentDict, country: string, opts: FormatAddressOptions = {}): string {
	return formatAddressRow(components, country, opts)?.raw ?? ""
}

/**
 * A rendered address and the components that survived the render.
 */
export interface AddressRow {
	/**
	 * The rendered string.
	 */
	readonly raw: string
	/**
	 * The subset of the input dict the layout PRINTED, with the caller's original values. This is the half a corpus row
	 * needs: a label whose text is not in `raw` cannot be aligned against it.
	 */
	readonly components: ComponentDict
	/**
	 * Tags the dict carried a value for that the layout has no slot for, NAMED rather than silently dropped. France
	 * absorbing a region into its postcode line is the common case.
	 */
	readonly unplaced: readonly ComponentTag[]
}

/**
 * Render `components` for `country` and report what the layout printed, in one pass.
 *
 * Returns null when nothing rendered — an empty dict, a country with no layout, or a dict whose every value falls in a
 * slot this country omits. Every corpus adapter asked both questions and paid for two renders to get them, then
 * recovered the alignment by searching the output string for each value; that search cannot tell a component the layout
 * dropped from one whose value happens to sit inside another — `Paris` inside `Rue de Paris`. The render knows, so the
 * answer is read rather than inferred.
 */
export function formatAddressRow(
	components: ComponentDict,
	country: string,
	opts: FormatAddressOptions = {}
): AddressRow | null {
	const layout = layoutForCountry(country)

	if (!layout) return null

	const rendering = renderAddress(layout, components)

	if (!rendering.placed.length) return null

	const raw = joinRendering(rendering, separatorFor(country, opts))

	if (!raw) return null

	const placed: ComponentDict = {}

	for (const tag of rendering.placed) {
		const value = components[tag]

		if (value) {
			placed[tag] = value
		}
	}

	return { raw, components: placed, unplaced: rendering.unplaced }
}

/**
 * Which of `components` occur verbatim in `raw`, case- and whitespace-insensitively.
 *
 * This is a question about a string somebody else built — a committed golden fixture, a source's own address line — and
 * it is the WEAKER of the two reconciliations: a substring test cannot tell a component the renderer dropped from one
 * whose value happens to sit inside another. Anything rendered through a layout should read
 * {@linkcode formatAddressRow}'s `components` instead, which the render knows rather than infers.
 */
export function componentsPresentIn(components: ComponentDict, raw: string): ComponentDict {
	const haystack = raw.toLowerCase().replaceAll(/\s+/g, " ")
	const out: ComponentDict = {}

	for (const [tag, value] of Object.entries(components)) {
		if (!value) continue

		if (haystack.includes(value.toLowerCase().replaceAll(/\s+/g, " "))) {
			out[tag as ComponentTag] = value
		}
	}

	return out
}
