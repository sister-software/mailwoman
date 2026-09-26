/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reading a coordinate eval set as a panel and writing a row through its country's layout.
 */

import { type ComponentDict, formatAddress } from "@mailwoman/codex/address-format"
import { US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us/street-suffix"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { stripParentheticalQualifier } from "#eval-harness/oa/locality-qualifier"

/**
 * One row of a coordinate eval set, as the files on disk write it.
 */
export interface CoordRow {
	input: string
	lat?: number
	lon?: number
	/**
	 * The row's own country, when the set carries one; a single-locale set carries none
	 * and takes the reader's default.
	 */
	country?: string
	expected?: { locality?: string; region?: string; postcode?: string }
}

/**
 * One panel place: the components a bare admin surface is written from, plus where it is.
 */
export interface PanelLocality {
	locality: string
	region: string
	postcode: string
	country: string
	lat: number
	lon: number
	/**
	 * The set's own `input` string for this place, carried so a probe that needs a
	 * real street takes it from the row rather than inventing one.
	 */
	input: string
}

/**
 * A panel and what reading it had to change.
 */
export interface CoordPanel {
	localities: PanelLocality[]
	/**
	 * Rows whose expected locality carried a trailing parenthetical, stripped before grading,
	 * counted so a caller can see how much of the panel the normalizer changed.
	 */
	qualifiersStripped: number
}

/**
 * Read a coordinate eval set into one row per place, keyed by country, region and name
 * because 30 US states hold a Springfield and a name-only key would collapse them.
 */
export async function readCoordPanel(
	path: PathBuilderLike,
	opts: { country?: string; limit?: number } = {}
): Promise<CoordPanel> {
	const defaultCountry = (opts.country ?? "US").toUpperCase()
	const byKey = new Map<string, PanelLocality>()
	let qualifiersStripped = 0

	for await (const row of JSONSpliterator.fromAsync<CoordRow>(path)) {
		const raw = row.expected?.locality?.trim()
		const region = row.expected?.region?.trim()
		const postcode = row.expected?.postcode?.trim()
		const locality = raw ? stripParentheticalQualifier(raw) : raw

		if (raw && locality !== raw) {
			qualifiersStripped++
		}

		const country = (row.country ?? defaultCountry).toUpperCase()
		const key = `${country}|${region}|${locality}`

		if (!locality || !region || !postcode || row.lat == null || row.lon == null || byKey.has(key)) continue

		byKey.set(key, { locality, region, postcode, country, lat: row.lat, lon: row.lon, input: row.input })
	}

	const localities = [...byKey.values()]

	return { localities: opts.limit ? localities.slice(0, opts.limit) : localities, qualifiersStripped }
}

/**
 * Write a panel place through its country's codex layout, with any extra components
 * folded into the dict, because `${locality}, ${region} ${postcode}` is the United
 * States postal order and prints other countries backwards.
 *
 * Answers `""` when no layout can write the country, which is an absence rather than an invented order.
 */
export function renderAdmin(place: PanelLocality, extra: ComponentDict = {}): string {
	return formatAddress(
		{ locality: place.locality, region: place.region, postcode: place.postcode, ...extra },
		place.country,
		{ singleLine: true }
	)
}

/**
 * The place's last word when it is a USPS suffix, membership drawn from the whole
 * `US_STREET_SUFFIX_LOOKUP` table because which bucket a row lands in is a property of that word list.
 */
export function suffixTail(locality: string): string | undefined {
	const last = locality
		.trim()
		.split(/\s+/)
		.at(-1)
		?.toLowerCase()
		.replaceAll(/[^a-z]/g, "")

	return last && US_STREET_SUFFIX_LOOKUP.has(last) ? last : undefined
}
