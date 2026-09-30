/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reduce the saved Overpass response to one point per `BT` unit postcode.
 *
 *   The response is a flat list of OSM elements. Each element claims a postcode on an address.
 *   The database needs one coordinate per postcode. This module does three things and counts every drop:
 *
 *   1. **Validate** against the BT unit shape. OSM tag values are free text typed by humans, so a
 *      format check is what keeps a typo from becoming a searchable place.
 *   2. **Normalize** to the uppercase single-space display form, with the space-stripped form as the
 *      lookup name. See `normalizePostcodeName`.
 *   3. **Collapse** the members of each postcode to the medoid point (`medoidPoint`) rather than the
 *      mean.
 */

import { medoidPoint, normalizePostcodeName, type PostcodePoint } from "@mailwoman/resolver-wof-sqlite/geonames"

import { normalizePostcodeDisplay } from "#gazetteer/postcode/display-form"
import type { OverpassElement, OverpassResponse } from "#gazetteer/postcode/ni/osm/fetch"

/**
 * A Northern Ireland unit postcode.
 *
 * This is the GB unit-postcode shape (`../codepoint/parse.ts`'s `UNIT_POSTCODE`)
 * with the area pinned to `BT`.
 * The outward code's second character is optional.
 *
 * `BT1` `BT1` and `BT47` are both legal forms with different outward structures.
 * The pattern requires the system-wide inward-code shape.
 *
 * The `[A-Z0-9]?` slot cannot fire for a real BT district (they are `BT1`–`BT94`, all-numeric),
 * and is kept rather than tightened to `[0-9]?` so the pattern stays recognisably the national one.
 *
 * A narrower check would encode today's district list into the format validation.
 */
export const NI_UNIT_POSTCODE = /^BT[0-9][A-Z0-9]?\s[0-9][A-Z]{2}$/

/**
 * Records what a parse run read, what it dropped, plus the reason for each drop.
 *
 * Use counters.
 * The database provenance can then explain each zero.
 * "Measured, none" is a different claim from "never looked".
 */
export interface NIOSMParseStats {
	/**
	 * Elements in the response.
	 */
	elements: number
	/**
	 * Elements carrying an `addr:postcode` tag.
	 *
	 * Below {@link elements} only if Overpass ever returns an element the tag filter did not select.
	 */
	tagged: number
	/**
	 * Elements dropped for having no usable coordinate: neither a node `lat`/`lon`
	 * nor an `out center` centre.
	 */
	skippedNoCoordinate: number
	/**
	 * Elements dropped because the tag value is not a BT unit postcode.
	 */
	skippedMalformed: number
	/**
	 * The distinct malformed values, with their element counts.
	 *
	 * Kept verbatim and capped so the dropped values stay visible in the database's `meta`.
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
 * How many distinct malformed values to retain.
 *
 * The counter is the signal.
 * The samples are the diagnosis.
 *
 * An unbounded map would let a filter regression write a million keys into the database's `meta`.
 */
const MALFORMED_SAMPLE_LIMIT = 50

/**
 * One unit postcode with its collapsed coordinate.
 */
export interface NIPostcodeRecord {
	/**
	 * The single-space display form, e.g. `BT3 9QQ`.
	 * This is an alt `names` row on the built place.
	 */
	display: string
	/**
	 * The lookup form, e.g. `BT39QQ`, stored as `spr.name`.
	 */
	name: string
	latitude: number
	longitude: number
	/**
	 * How many OSM elements attested this postcode.
	 *
	 * This is coverage evidence.
	 * A database consumer can distinguish a one-node guess from a 40-building consensus.
	 */
	attestations: number
	/**
	 * Postcode district, e.g. `BT3`, the outward code.
	 */
	district: string
	/**
	 * Postcode sector, e.g. `BT3 9`: the outward code plus the first inward digit.
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
 * Normalize an OSM `addr:postcode` value to the single-space display form.
 *
 * Non-breaking spaces occur in hand-typed tags and are invisible in an editor.
 * {@link normalizePostcodeDisplay} folds them too.
 */
export function normalizeOSMPostcode(raw: string): string {
	return normalizePostcodeDisplay(raw)
}

/**
 * Read an element's coordinate: nodes provide `lat`/`lon` directly, while ways
 * and relations provide `center` because the query asked for `out center`.
 *
 * @returns Null when neither is usable.
 */
function elementPoint(element: OverpassElement): PostcodePoint | null {
	const lat = element.lat ?? element.center?.lat
	const lon = element.lon ?? element.center?.lon

	if (typeof lat !== "number" || typeof lon !== "number") return null

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

	return [lat, lon]
}

/**
 * Group the response's elements into one {@link NIPostcodeRecord} per distinct
 * unit postcode, mutating `stats`.
 *
 * Records come back sorted by lookup `name`.
 * Insertion order would also be deterministic given a fixed response file,
 * but it would be deterministic through the file's element order.
 *
 * The sort makes the database's synthetic ids a function only of the postcode set,
 * so a rebuild of OSM that adds one building does not renumber every place after it.
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
