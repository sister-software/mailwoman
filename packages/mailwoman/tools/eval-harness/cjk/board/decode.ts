/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turns a per-character label sequence back into the surfaces a CJK board row claims.
 *
 *   The reconstruction is the pre-registered one: contiguous B/I runs of one tag over the row's code points. Every
 *   offset here counts code points, the unit the board's `span_starts` and `span_ends` use.
 */

import { pythonSplitWhitespace, pythonStrip } from "@mailwoman/core/strings/python-text"
import { centralAngle } from "@mailwoman/spatial/distance"

/**
 * The Earth radius the board's acceptability radius was registered with, in kilometers.
 *
 * It is the IUGG mean radius.
 * `EARTH_RADII.km` is 6371, so the board keeps its own constant.
 */
export const BOARD_EARTH_RADIUS_KM = 6371.0088

/**
 * The centroid table's key form of `text`: NFC, with every whitespace character removed.
 */
export function normalizeCentroidKey(text: string): string {
	return pythonSplitWhitespace(text.normalize("NFC")).join("").replaceAll("　", "")
}

/**
 * The great-circle distance in kilometers between two `(lon, lat)` points at the board's radius.
 */
export function boardArcKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
	return BOARD_EARTH_RADIUS_KM * centralAngle(lat1, lon1, lat2, lon2)
}

/**
 * Every contiguous B/I run per tag, in reading order, as `[start, end)` code-point offsets.
 *
 * A negative label id reads as `O`.
 * A B label, or an I label of another tag, starts a new run.
 */
export function decodeRuns(
	raw: string,
	labelIDs: readonly number[],
	labels: readonly string[]
): Map<string, Array<[number, number]>> {
	const runs = new Map<string, Array<[number, number]>>()
	const length = Math.min([...raw].length, labelIDs.length)
	let currentTag: string | null = null
	let currentStart = 0

	const close = (end: number) => {
		if (currentTag === null) return

		const tagRuns = runs.get(currentTag) ?? []

		tagRuns.push([currentStart, end])
		runs.set(currentTag, tagRuns)
	}

	for (let index = 0; index < length; index++) {
		const id = labelIDs[index]!
		const label = id >= 0 ? labels[id] : "O"

		if (typeof label !== "string") throw new Error(`label id ${id} is outside the ${labels.length}-label head`)

		if (label === "O") {
			close(index)
			currentTag = null

			continue
		}

		const separator = label.indexOf("-")
		const prefix = label.slice(0, separator)
		const tag = label.slice(separator + 1)

		if (prefix === "B" || tag !== currentTag) {
			close(index)
			currentTag = tag
			currentStart = index
		}
	}

	close(length)

	return runs
}

/**
 * Every run's surface per tag in reading order, followed by the surface of each
 * group of same-tag runs that only whitespace separates.
 *
 * A tag can occur more than once in one row.
 * The KR ladder puts 읍/면 and the 리 below it on one `dependent_locality` tag (`신림면 구학리`),
 * and `수원시 장안구` is two `subregion` spans, so each gold span is scored against the whole list.
 *
 * The model labels the space inside the permit register's `1층 141호` as `O`,
 * and the served projection joins the two runs with the raw's own whitespace.
 * The grouped surface reads the unit the same way.
 */
export function decodeAllSpans(
	raw: string,
	labelIDs: readonly number[],
	labels: readonly string[]
): Map<string, string[]> {
	const codePoints = [...raw]
	const slice = (start: number, end: number) => codePoints.slice(start, end).join("")
	const spans = new Map<string, string[]>()

	for (const [tag, offsets] of decodeRuns(raw, labelIDs, labels)) {
		const surfaces = offsets.map(([start, end]) => slice(start, end))
		const groups: Array<[number, number, number]> = []
		let [groupStart, groupEnd] = offsets[0]!
		let groupSize = 1

		for (const [start, end] of offsets.slice(1)) {
			if (pythonStrip(slice(groupEnd, start)) === "") {
				groupEnd = end

				groupSize++

				continue
			}

			groups.push([groupStart, groupEnd, groupSize])
			groupStart = start
			groupEnd = end
			groupSize = 1
		}

		groups.push([groupStart, groupEnd, groupSize])

		for (const [start, end, size] of groups) {
			const surface = slice(start, end)

			if (size > 1 && !surfaces.includes(surface)) {
				surfaces.push(surface)
			}
		}

		spans.set(tag, surfaces)
	}

	return spans
}
