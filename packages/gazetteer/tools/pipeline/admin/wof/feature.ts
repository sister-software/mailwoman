// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Extracts the fields the admin gazetteer stores from one WOF GeoJSON record.
 *
 * The extraction reads only the record's text, so it runs in a worker thread.
 * The GeoNames anchor lookup stays with the caller, because it reads opened GeoNames extracts.
 *
 * The lookup can move a locality's point.
 * The ingest widens the record's `geom:bbox` to cover that final point.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import type { GeoCoordinate } from "@mailwoman/spatial/position"

import { isSupersededRecord, type WOFNamesOf } from "#tools/pipeline/wof/slim"
import type { WOFFeature, WOFProperties } from "#whosonfirst"

/**
 * The number of values in a 2D bounding box: `[west, south, east, north]`.
 */
const BBOX_2D_LENGTH = 4

/**
 * One name a WOF record holds under a `name:<lang>[_<subtag>…]_x_<kind>` property.
 */
export interface WOFFeatureName {
	name: string
	/**
	 * The key's language tag without its kind: `eng`, or `zho_tw` for a tag with subtags.
	 */
	language: string
	privateuse: string
	official: number
}

/**
 * The name kinds a postal address writes: the preferred and variant names,
 * a colloquial name (`Lion City`, `NYC`) and an unclassified one.
 *
 * An unclassified name is mostly a code (`CBA` for Córdoba, `BHR`).
 *
 * A `historical` name is left out, because an address doesn't write one.
 * Nearly every one repeats a name the record already holds.
 *
 * The rest are superseded names (`Département des Basses-Pyrénées`) or the titles of
 * Wikipedia disambiguation pages (`Mazedonien (Begriffsklärung)`).
 */
const ADDRESS_NAME_KINDS = ["preferred", "variant", "colloquial", "unknown"] as const

/**
 * A `name:*` key: an ISO 639-3 language, any subtags (a region in `zho_tw`, a script in
 * `srp_lat`, a variety in `zho_min_nan`), and one of {@linkcode ADDRESS_NAME_KINDS}.
 */
const NAME_KEY = new RegExp(`^name:(([a-z]{3})(?:_[a-z0-9]+)*)_x_(${ADDRESS_NAME_KINDS.join("|")})$`)

/**
 * The stored fields of one WOF record, before any GeoNames adjudication of its point.
 */
export interface ExtractedWOFFeature {
	id: number
	parent_id: number
	name: string
	placetype: string
	country: string
	/**
	 * The label point when the record has both label coordinates, the geometry point otherwise, else `0, 0`.
	 */
	point: GeoCoordinate
	/**
	 * `[west, south, east, north]` from `geom:bbox`, or `null` when the record has no usable one.
	 */
	bbox: [number, number, number, number] | null
	population: number
	isCurrent: number
	isDeprecated: number
	isCeased: number
	isSuperseded: number
	isSuperseding: number
	lastmodified: number
	concordances: Record<string, string | number>
	names: WOFFeatureName[]
	/**
	 * The inputs GeoNames adjudication reads, present for a locality that has
	 * both a label and a geometry point.
	 */
	adjudication: { geom: GeoCoordinate; lbl: GeoCoordinate; gnID: string | number | null; country: string | null } | null
}

/**
 * A WOF record's point: its label point, else its geometry point, else null.
 *
 * A point counts only when the record holds both of its coordinates.
 */
export function wofRecordPoint(props: WOFProperties): GeoCoordinate | null {
	const lbl = { latitude: props["lbl:latitude"], longitude: props["lbl:longitude"] }
	const geom = { latitude: props["geom:latitude"], longitude: props["geom:longitude"] }

	for (const { latitude, longitude } of [lbl, geom]) {
		if (typeof latitude === "number" && typeof longitude === "number") return { latitude, longitude }
	}

	return null
}

/**
 * Extracts the stored fields from one WOF record's text.
 *
 * @returns `null` for a record with no properties, a superseded record, or a placetype outside `placetypes`.
 */
export function extractWOFFeature(text: string, placetypes: ReadonlySet<string>): ExtractedWOFFeature | null {
	return extractParsedWOFFeature(parseJSONStrict<WOFFeature>(text), placetypes)
}

/**
 * Extracts the stored fields from one parsed WOF record, such as a record store's reduced feature.
 *
 * @returns `null` for a record with no properties, a superseded record, or a placetype outside `placetypes`.
 * `namesOf` reads a successor's names, so a ceased administrative division whose
 * successors have other names is kept (`isSupersededRecord`).
 */
export function extractParsedWOFFeature(
	feature: Pick<WOFFeature, "properties">,
	placetypes: ReadonlySet<string>,
	namesOf?: WOFNamesOf
): ExtractedWOFFeature | null {
	const props: WOFProperties | undefined = feature.properties

	if (!props) return null

	if (isSupersededRecord({ properties: props }, namesOf)) return null

	const placetype = props["wof:placetype"]

	if (!placetypes.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

	const hasLbl = typeof props["lbl:latitude"] === "number" && typeof props["lbl:longitude"] === "number"
	const hasGeom = typeof props["geom:latitude"] === "number" && typeof props["geom:longitude"] === "number"
	const point: GeoCoordinate = wofRecordPoint(props) ?? { latitude: 0, longitude: 0 }

	// Only localities use GeoNames adjudication.
	// GeoNames anchors for regions and counties are centroids.
	const adjudication =
		placetype === "locality" && hasLbl && hasGeom
			? {
					geom: { latitude: props["geom:latitude"]!, longitude: props["geom:longitude"]! },
					lbl: { latitude: props["lbl:latitude"]!, longitude: props["lbl:longitude"]! },
					gnID: props["wof:concordances"]?.["gn:id"] ?? null,
					country: props["wof:country"] ?? null,
				}
			: null

	// WOF orders the bbox as west, south, east, north.
	let bbox: ExtractedWOFFeature["bbox"] = null
	const bboxStr = props["geom:bbox"]

	if (typeof bboxStr === "string") {
		const parts = bboxStr.split(",").map(Number)

		// An all-zero bbox is WOF's unlocated sentinel rather than an extent at `0, 0`.
		if (parts.length === BBOX_2D_LENGTH && parts.every((n) => Number.isFinite(n)) && parts.some((n) => n !== 0)) {
			bbox = parts as [number, number, number, number]
		}
	}

	const names: WOFFeatureName[] = []
	const country = props["wof:country"] ?? ""

	for (const [key, value] of Object.entries(props)) {
		const match = NAME_KEY.exec(key)

		if (!match || !value) continue
		const language = match[1]!
		const privateuse = match[3]!
		// A name is official only when it is a preferred form in an official language.
		const official = privateuse === "preferred" && isOfficialLanguage(country, match[2]!) ? 1 : 0
		const vals = Array.isArray(value) ? value : [value]

		for (const v of vals) {
			if (typeof v === "string" && v) {
				names.push({ name: v, language, privateuse, official })
			}
		}
	}

	return {
		id: props["wof:id"],
		parent_id: props["wof:parent_id"] ?? -1,
		name: props["wof:name"] ?? "",
		placetype,
		country: props["wof:country"] ?? "",
		point,
		bbox,
		population: props["wof:population"] ?? props["gn:population"] ?? 0,
		isCurrent: mzIsCurrent === 0 || mzIsCurrent === "0" ? 0 : 1,
		isDeprecated: props["edtf:deprecated"] ? 1 : 0,
		isCeased: props["edtf:cessation"] ? 1 : 0,
		isSuperseded: (props["wof:superseded_by"]?.length ?? 0) > 0 ? 1 : 0,
		isSuperseding: (props["wof:supersedes"]?.length ?? 0) > 0 ? 1 : 0,
		lastmodified: typeof props["wof:lastmodified"] === "number" ? props["wof:lastmodified"] : 0,
		concordances: props["wof:concordances"] ?? {},
		names,
		adjudication,
	}
}
