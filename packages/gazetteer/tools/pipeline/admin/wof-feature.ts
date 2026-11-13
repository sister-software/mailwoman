// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Extracts the fields the admin gazetteer stores from one WOF GeoJSON record.
 *
 * The extraction reads only the record's text, so it runs in a worker thread.
 * The GeoNames anchor lookup stays with the caller, because it reads opened GeoNames extracts.
 *
 * The lookup can move a locality's point.
 * A record without a `geom:bbox` takes that final point as its bounding box.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { parseJSONStrict } from "@mailwoman/core/json"

import type { WOFFeature, WOFProperties } from "#whosonfirst"

/**
 * The number of values in a 2D bounding box: `[west, south, east, north]`.
 */
const BBOX_2D_LENGTH = 4

/**
 * A latitude and longitude pair.
 */
export interface WOFPoint {
	latitude: number
	longitude: number
}

/**
 * One name a WOF record holds under a `name:<lang>_x_<preferred|variant>` property.
 */
export interface WOFFeatureName {
	name: string
	language: string
	privateuse: string
	official: number
}

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
	point: WOFPoint
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
	adjudication: { geom: WOFPoint; lbl: WOFPoint; gnID: string | number | null; country: string | null } | null
}

/**
 * Extracts the stored fields from one WOF record's text.
 *
 * @returns `null` for a record with no properties, a superseded record, or a placetype outside `placetypes`.
 */
export function extractWOFFeature(text: string, placetypes: ReadonlySet<string>): ExtractedWOFFeature | null {
	const feature = parseJSONStrict<WOFFeature>(text)
	const props: WOFProperties | undefined = feature.properties

	if (!props) return null

	const supersededBy = props["wof:superseded_by"]

	if (supersededBy && supersededBy.length) return null

	const placetype = props["wof:placetype"]

	if (!placetypes.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

	// The label point is preferred over the geometry point.
	// Either point counts only with both coordinates.
	const hasLbl = typeof props["lbl:latitude"] === "number" && typeof props["lbl:longitude"] === "number"
	const hasGeom = typeof props["geom:latitude"] === "number" && typeof props["geom:longitude"] === "number"

	const point: WOFPoint = {
		latitude: hasLbl ? props["lbl:latitude"]! : hasGeom ? props["geom:latitude"]! : 0,
		longitude: hasLbl ? props["lbl:longitude"]! : hasGeom ? props["geom:longitude"]! : 0,
	}

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

		if (parts.length === BBOX_2D_LENGTH && parts.every((n) => Number.isFinite(n))) {
			bbox = parts as [number, number, number, number]
		}
	}

	const names: WOFFeatureName[] = []
	const country = props["wof:country"] ?? ""

	for (const [key, value] of Object.entries(props)) {
		const match = key.match(/^name:([a-z]{3})_x_(preferred|variant)$/)

		if (!match || !value) continue
		const lang = match[1]!
		const privateuse = match[2]!
		// A name is official only when it is a preferred form in an official language.
		const official = privateuse === "preferred" && isOfficialLanguage(country, lang) ? 1 : 0
		const vals = Array.isArray(value) ? value : [value]

		for (const v of vals) {
			if (typeof v === "string" && v) {
				names.push({ name: v, language: lang, privateuse, official })
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
