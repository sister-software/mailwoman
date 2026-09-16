/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The coordinate panel as a panel — reading it, writing a row through its country's layout, and the one split
 *   every probe over it stratifies by. Shared by the tools that measure the bare admin surface, because each of these
 *   was written twice before it was written once.
 */

import { type ComponentDict, formatAddress } from "@mailwoman/codex/address-format"
import { US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us/street-suffix"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

/**
 * One row of a coordinate eval set, as the files on disk write it.
 */
export interface CoordRow {
	input: string
	lat?: number
	lon?: number
	/**
	 * The row's own country, when the set carries one. A single-locale set carries none and takes the reader's default,
	 * so every row need not repeat the same code.
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
	 * The set's own `input` string for this place, carried through so a probe that needs a real street — or any other
	 * part of a written address — takes it from the row rather than inventing one.
	 */
	input: string
}

/**
 * A panel and what reading it had to change.
 */
export interface CoordPanel {
	localities: PanelLocality[]
	/**
	 * Rows whose expected locality carried a trailing parenthetical, stripped before grading. Reported rather than
	 * silent: a normalizer nobody counts is a grader quietly deciding what correct means.
	 */
	qualifiersStripped: number
}

/**
 * A trailing postal qualifier in parentheses, which an expected string sometimes carries and no locality name ever
 * does: `Manilla (Rural)` is the town of Manilla reached on a rural route.
 *
 * Grading against the raw expectation marks a correct answer wrong — the model answers `Manilla`, which IS the place —
 * and a gold lookup keyed on the name finds nothing either. The strip applies to the EXPECTATION only, never to what
 * the run answered.
 */
const PARENTHETICAL_QUALIFIER = /\s*\([^)]*\)\s*$/

/**
 * Read a coordinate eval set into one row per place.
 *
 * Keyed by country, region AND name: 30 US states hold a Springfield, and a name-only key collapses them into one row
 * while shrinking the panel silently — reading a 5,703-row source, that key dropped 639 rows.
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
		const locality = raw?.replace(PARENTHETICAL_QUALIFIER, "").trim() || raw

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
 * A panel place written through its country's codex layout, with any extra components folded into the dict.
 *
 * `${locality}, ${region} ${postcode}` is the United States postal order and nothing else: it prints Japan's admin run
 * backwards, drops each country's own separator convention, and puts a postcode after a region in the systems that lead
 * with it. A surface that differs only in which components are PRESENT — a country name, a house number and a street —
 * is a dict, not a template.
 *
 * Answers `""` when no layout can write the country: 55 of the 252 shipped records carry no usable skeleton, and
 * reporting nothing for one of those is an absence rather than an invented order.
 */
export function renderAdmin(place: PanelLocality, extra: ComponentDict = {}): string {
	return formatAddress(
		{ locality: place.locality, region: place.region, postcode: place.postcode, ...extra },
		place.country,
		{ singleLine: true }
	)
}

/**
 * The place's last word, when that word is a USPS suffix — the collision a US admin surface splits on (#2308).
 *
 * Membership is `US_STREET_SUFFIX_LOOKUP`: every Pub-28 canonical AND every variant, not the curated name-prone subset.
 * The narrower list moves rows between buckets and moves every bucket's rate with them, so which bucket a row lands in
 * is a property of the word list, and the word list has to be the whole table.
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
