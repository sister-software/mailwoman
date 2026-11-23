// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes Who's On First records into a fork clone in the layout the WOF exporter writes.
 *
 *   An exported record prints its properties as Python's `json.dumps(indent=4, separators=(",", ":"),
 *   sort_keys=True)` does, placed inside a fixed outer object: two-space `id`, `type`, `properties`,
 *   `bbox` and `geometry` keys, with the geometry on one line. A record written in that layout differs
 *   from an upstream record only in the lines whose values differ, and can be offered upstream as written.
 *
 *   The exporter writes a property float with an integral value as `18.0`, and JavaScript keeps no float type.
 *   {@link WOF_FLOAT_PROPERTIES} lists the properties the exporter writes as floats.
 *   An integral bbox coordinate is also written `-81.0`. The geometry is `wofGeometryJSON`, the text
 *   `wof:geomhash` is computed over.
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { isMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { pythonJSONString } from "@mailwoman/core/strings/python-json"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { wofGeometryJSON } from "#tools/pipeline/wof/slim"
import { wofIDPathSegments } from "#whosonfirst/extract-repo"

/**
 * A WOF GeoJSON feature as a fork record holds it.
 */
export interface WOFRecordFeature {
	id: number
	type: "Feature"
	properties: Record<string, unknown>
	bbox: [number, number, number, number]
	geometry: { type: string; coordinates: unknown }
}

/**
 * The properties the WOF exporter writes as floats even when their value is integral.
 */
export const WOF_FLOAT_PROPERTIES: ReadonlySet<string> = new Set([
	"geom:area",
	"geom:area_square_m",
	"geom:latitude",
	"geom:longitude",
	"lbl:latitude",
	"lbl:longitude",
	"lbl:max_zoom",
	"lbl:min_zoom",
	"mps:latitude",
	"mps:longitude",
	"mz:max_zoom",
	"mz:min_zoom",
	"reversegeo:latitude",
	"reversegeo:longitude",
])

const INDENT = "    "

/**
 * A number as the exporter prints it in a geometry or bbox: the shortest round-trip form,
 * with `.0` after an integral float.
 */
function formatNumber(value: number, float: boolean): string {
	return float && Number.isInteger(value) ? `${value}.0` : stringifyJSON(value)
}

/**
 * A property number as the exporter prints it.
 *
 * A non-integral value is written with six decimal places and its trailing zeros dropped,
 * so `36418040003.8091` reads `36418040003.809097`, the six-place form of the same double.
 */
function formatPropertyNumber(value: number, float: boolean): string {
	if (Number.isInteger(value)) return formatNumber(value, float)

	return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, ".0")
}

/**
 * One value as `json.dumps(indent=4, separators=(",", ":"), sort_keys=True)` prints it at `depth`.
 *
 * `float` marks every number below this value as a float.
 */
function formatIndented(value: unknown, depth: number, float: boolean): string {
	if (typeof value === "number") return formatPropertyNumber(value, float)

	if (typeof value === "string") return pythonJSONString(value)

	if (value === null || typeof value !== "object") return stringifyJSON(value)

	const inner = INDENT.repeat(depth + 1)
	const outer = INDENT.repeat(depth)

	if (Array.isArray(value)) {
		if (!value.length) return "[]"

		return `[\n${value.map((item) => inner + formatIndented(item, depth + 1, float)).join(",\n")}\n${outer}]`
	}

	const keys = Object.keys(value).toSorted()

	if (!keys.length) return "{}"

	const lines = keys.map((key) => {
		const item = (value as Record<string, unknown>)[key]

		return `${inner}${pythonJSONString(key)}:${formatIndented(item, depth + 1, float || WOF_FLOAT_PROPERTIES.has(key))}`
	})

	return `{\n${lines.join(",\n")}\n${outer}}`
}

/**
 * A feature's text in the WOF exporter's layout, without a trailing newline, as exported records end.
 */
export function formatWOFFeature(feature: WOFRecordFeature): string {
	const bbox = feature.bbox.map((coordinate) => INDENT + formatNumber(coordinate, true)).join(",\n")

	return [
		"{",
		`  "id": ${feature.id},`,
		`  "type": "Feature",`,
		`  "properties": ${formatIndented(feature.properties, 0, false)},`,
		`  "bbox": [\n${bbox}\n],`,
		`  "geometry": ${wofGeometryJSON(feature.geometry)}`,
		"}",
	].join("\n")
}

/**
 * The path of a record's file in a repository clone: `<repo>/data/<3>/<3>/…/<id>.geojson`.
 */
export function wofRecordPath(repoDir: PathBuilderLike, id: number): PathBuilder {
	return PathBuilder.from(repoDir)("data", ...wofIDPathSegments(id))
}

/**
 * Writes a record into a repository clone at its WOF path.
 */
export async function writeWOFRecord(repoDir: PathBuilderLike, feature: WOFRecordFeature): Promise<PathBuilder> {
	const path = wofRecordPath(repoDir, feature.id)

	await writeLocalTextFile(formatWOFFeature(feature), path)

	return path
}

/**
 * Every record in the mailwoman id range across the given repository clones.
 *
 * The range's ids all begin `9895`, so the scan reads only `data/989/5*`.
 * A minter passes these ids to `nextMailwomanWOFID`, and a backfill reads their
 * concordances to skip a place it already wrote.
 */
export async function readMailwomanWOFRecords(repoDirs: readonly PathBuilderLike[]): Promise<WOFRecordFeature[]> {
	const records: WOFRecordFeature[] = []

	for (const repoDir of repoDirs) {
		const root = PathBuilder.from(repoDir)("data", "989")

		if (!(await pathExists(root))) continue

		for (const path of await sortedGlob(root, "5*/**/[0-9]*[0-9].geojson")) {
			const feature = await readLocalJSONFile<WOFRecordFeature>(path)

			if (isMailwomanWOFID(feature.id)) {
				records.push(feature)
			}
		}
	}

	return records
}
