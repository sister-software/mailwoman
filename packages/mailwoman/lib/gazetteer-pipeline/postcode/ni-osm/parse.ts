/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reduce the saved Overpass response to one point per `BT` unit postcode.
 *
 *   The response is a flat list of OSM elements that each CLAIM a postcode on an address; the shard needs one
 *   coordinate per postcode. So this module does three things and counts everything it drops:
 *
 *   1. **Validate** against the BT unit shape. OSM tag values are free text typed by humans, and this
 *      acquisition contains exactly one value that is not a postcode (`"BT36 4RU,"` — a trailing comma).
 *      One in 12,327 is not a reason to skip validation; it is the reason to have it, because the failure
 *      mode of accepting it is a searchable place named after a typo.
 *   2. **Normalize** under the #920 name law — uppercase, single-space display form, and the
 *      space-stripped form as the lookup name. See `normalizePostcodeName`.
 *   3. **Collapse** the members of each postcode to the MEDOID point (`medoidPoint`), never the mean.
 *
 *   ## Measured against the 2026-08-05 acquisition
 *
 *   12,327 elements (2,752 nodes · 9,458 ways · 117 relations), every one of them carrying both an
 *   `addr:postcode` and a coordinate — so `skippedNoCoordinate` is a MEASURED zero here, not an untested
 *   path. 1 malformed value. 4,757 distinct valid unit postcodes across 80 districts and 250 sectors.
 */

import { medoidPoint, normalizePostcodeName, type PostcodePoint } from "@mailwoman/resolver-wof-sqlite/geonames-postal"

import { normalizePostcodeDisplay } from "#gazetteer-pipeline/postcode/display-form"
import type { OverpassElement, OverpassResponse } from "#gazetteer-pipeline/postcode/ni-osm/fetch"

/**
 * A Northern Ireland unit postcode.
 *
 * This is the GB unit-postcode shape (`../codepoint/parse.ts`'s `UNIT_POSTCODE`) with the area pinned to `BT`: loose
 * about the outward code's second character, because `BT1` and `BT47` are both legal and differ structurally, and
 * strict about the inward code, which is invariant across the whole system. The `[A-Z0-9]?` slot cannot fire for a real
 * BT district (they are `BT1`–`BT94`, all-numeric), and is kept rather than tightened to `[0-9]?` so the pattern stays
 * recognisably the national one — narrowing it would encode a fact about today's district list into a format check.
 */
export const NI_UNIT_POSTCODE = /^BT[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/

/**
 * What a parse run read and dropped, and why. Counters rather than booleans so the shard's provenance can state the
 * meaning of each zero — "measured, none" is a different claim from "never looked".
 */
export interface NIOSMParseStats {
	/**
	 * Elements in the response.
	 */
	elements: number
	/**
	 * Elements carrying an `addr:postcode` tag. Below {@link elements} only if Overpass ever returns an element the tag
	 * filter did not select.
	 */
	tagged: number
	/**
	 * Elements dropped for having no usable coordinate — neither a node `lat`/`lon` nor an `out center` centre.
	 */
	skippedNoCoordinate: number
	/**
	 * Elements dropped because the tag value is not a BT unit postcode.
	 */
	skippedMalformed: number
	/**
	 * The distinct malformed VALUES, with their element counts. Kept verbatim (capped) because a drop counter tells you
	 * something broke and this tells you what — `"BT36 4RU,"` is a typo, a sudden thousand `"BT"`s would be a filter
	 * bug.
	 */
	malformedValues: Record<string, number>
	/**
	 * Elements that survived to contribute a member point.
	 */
	points: number
	/**
	 * Per-element-type contributing counts (`node` / `way` / `relation`).
	 */
	pointsByType: Record<string, number>
}

/**
 * How many distinct malformed values to retain. A bounded list: the counter is the signal, the samples are the
 * diagnosis, and an unbounded map would let a filter regression write a million keys into the shard's `meta`.
 */
const MALFORMED_SAMPLE_LIMIT = 50

/**
 * One unit postcode with its collapsed coordinate.
 */
export interface NIPostcodeRecord {
	/**
	 * The single-space display form, e.g. `BT3 9QQ` — an alt `names` row on the built place.
	 */
	display: string
	/**
	 * The #920 lookup form, e.g. `BT39QQ` — `spr.name`.
	 */
	name: string
	latitude: number
	longitude: number
	/**
	 * How many OSM elements attested this postcode. Coverage evidence, and the reason a shard consumer can tell a
	 * one-node guess from a 40-building consensus.
	 */
	attestations: number
	/**
	 * Postcode district, e.g. `BT3` — the outward code.
	 */
	district: string
	/**
	 * Postcode sector, e.g. `BT3 9` — outward code plus the first inward digit.
	 */
	sector: string
}

/**
 * A zeroed stats accumulator.
 */
export function createNIOSMParseStats(): NIOSMParseStats {
	return {
		elements: 0,
		tagged: 0,
		skippedNoCoordinate: 0,
		skippedMalformed: 0,
		malformedValues: {},
		points: 0,
		pointsByType: {},
	}
}

/**
 * Normalize an OSM `addr:postcode` value to the single-space display form. Non-breaking spaces occur in hand-typed tags
 * and are invisible in an editor; {@link normalizePostcodeDisplay} folds them too.
 */
export function normalizeOSMPostcode(raw: string): string {
	return normalizePostcodeDisplay(raw)
}

/**
 * Read an element's coordinate: nodes carry `lat`/`lon` directly, ways and relations carry `center` because the query
 * asked for `out center`. Returns null when neither is usable.
 */
function elementPoint(element: OverpassElement): PostcodePoint | null {
	const lat = element.lat ?? element.center?.lat
	const lon = element.lon ?? element.center?.lon

	if (typeof lat !== "number" || typeof lon !== "number") return null

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

	return [lat, lon]
}

/**
 * Group the response's elements into one {@link NIPostcodeRecord} per distinct unit postcode, mutating `stats`.
 *
 * Records come back sorted by lookup `name`. Insertion order would also be deterministic given a fixed response file,
 * but it is deterministic THROUGH the file's element order — sorting makes the shard's synthetic ids a function of the
 * postcode set alone, so a re-cut of OSM that adds one building does not renumber every place after it.
 */
export function parseNIPostcodes(response: OverpassResponse, stats: NIOSMParseStats): NIPostcodeRecord[] {
	const groups = new Map<string, { display: string; points: PostcodePoint[] }>()

	for (const element of response.elements ?? []) {
		stats.elements++
		const raw = element.tags?.["addr:postcode"]

		if (!raw) continue

		stats.tagged++
		const display = normalizeOSMPostcode(raw)

		if (!NI_UNIT_POSTCODE.test(display)) {
			stats.skippedMalformed++

			if (display in stats.malformedValues || Object.keys(stats.malformedValues).length < MALFORMED_SAMPLE_LIMIT) {
				stats.malformedValues[display] = (stats.malformedValues[display] ?? 0) + 1
			}

			continue
		}

		const point = elementPoint(element)

		if (!point) {
			stats.skippedNoCoordinate++

			continue
		}

		stats.points++
		stats.pointsByType[element.type] = (stats.pointsByType[element.type] ?? 0) + 1

		const name = normalizePostcodeName(display)
		const group = groups.get(name) ?? { display, points: [] }
		group.points.push(point)
		groups.set(name, group)
	}

	const records: NIPostcodeRecord[] = []

	for (const [name, group] of groups) {
		const [latitude, longitude] = medoidPoint(group.points)
		const [outward, inward] = group.display.split(" ") as [string, string]

		records.push({
			display: group.display,
			name,
			latitude,
			longitude,
			attestations: group.points.length,
			district: outward,
			sector: `${outward} ${inward[0]}`,
		})
	}

	records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

	return records
}
