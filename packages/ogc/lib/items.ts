// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The query parsing and feature encoding of the OGC API Features Part 1 items resources,
 *   `/collections/{collectionId}/items` and `/collections/{collectionId}/items/{featureId}`.
 *
 *   A page is read in ascending WOF id order and continues after the last id it returned,
 *   so a deep page costs what the first page costs and no item repeats or goes missing between pages.
 */

import { isRFC3339DateTime } from "@mailwoman/core/utils"
import type { BrowsedPlace, WOFPlaceBrowser } from "@mailwoman/resolver-wof-sqlite/lookup/browse"

import { parseBBox } from "#bbox"
import type { OGCItem, OGCItemPageRequest, OGCItemSource } from "#engine"
import { type AncestorsOf, placeLabel } from "#projection"
import { type OGCItemFeature, OGC_ITEMS_DEFAULT_LIMIT, OGC_ITEMS_MAX_LIMIT } from "#schema"

/**
 * The open end of a `datetime` interval: `..`, or an empty string.
 */
function isOpenEnd(value: string): boolean {
	return value === ".." || value === ""
}

/**
 * Whether `raw` is a `datetime` value as OGC API Features Part 1, Requirement 26 D defines it:
 * an RFC 3339 `date-time`, or an interval of two with at most one open end.
 */
export function isFeaturesDateTime(raw: string): boolean {
	const parts = raw.split("/")

	if (parts.length === 1) return isRFC3339DateTime(raw)

	if (parts.length !== 2) return false

	const [start, end] = parts as [string, string]

	if (isOpenEnd(start) && isOpenEnd(end)) return false

	return (isOpenEnd(start) || isRFC3339DateTime(start)) && (isOpenEnd(end) || isRFC3339DateTime(end))
}

/**
 * Parse the `after` cursor a `next` link sets: a WOF id.
 */
function parseCursor(raw: string): number | null {
	if (!/^\d{1,16}$/.test(raw)) return null

	const value = Number(raw)

	return Number.isSafeInteger(value) ? value : null
}

/**
 * Validate a `/collections/{collectionId}/items` query the schema admitted.
 *
 * A `limit` above {@link OGC_ITEMS_MAX_LIMIT} is served as the maximum, as Requirement 22 C asks.
 * A valid `datetime` selects every place, because no place has a temporal geometry (Requirement 26 C).
 *
 * @returns The page request, or a message that identifies the invalid parameter.
 */
export function parseItemsQuery(query: Readonly<Record<string, string | undefined>>): OGCItemPageRequest | string {
	let limit = OGC_ITEMS_DEFAULT_LIMIT
	const rawLimit = query["limit"]

	if (rawLimit != null) {
		limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN

		if (!(limit >= 1)) return "limit: a positive integer is required"

		limit = Math.min(limit, OGC_ITEMS_MAX_LIMIT)
	}

	let bbox: OGCItemPageRequest["bbox"] = null
	const rawBBox = query["bbox"]

	if (rawBBox != null) {
		const parsed = parseBBox(rawBBox, { withHeight: true })

		if (typeof parsed === "string") return parsed

		bbox = parsed
	}

	const datetime = query["datetime"]

	if (datetime != null && !isFeaturesDateTime(datetime)) {
		return "datetime: an RFC 3339 date-time, or an interval of two separated by / with .. for an open end, is required"
	}

	let after: number | null = null
	const rawAfter = query["after"]

	if (rawAfter != null) {
		after = parseCursor(rawAfter)

		if (after == null) return "after: the WOF id a next link carries is required"
	}

	return { bbox, after, limit }
}

/**
 * The reader {@link placeItemSource} pages through, such as a `WOFPlaceBrowser` over the admin gazetteer.
 */
export type PlaceBrowser = Pick<WOFPlaceBrowser, "page" | "place">

/**
 * The item source of a collection of gazetteer places, read through `browser`.
 *
 * @param ancestorsOf The ancestry reader `/search` labels its places with,
 * so an item's `display_name` matches the label `/search` gives the same place.
 */
export function placeItemSource(browser: PlaceBrowser, ancestorsOf: AncestorsOf | undefined): OGCItemSource {
	const toItem = (place: BrowsedPlace): OGCItem => {
		const countryCode = place.country || null
		const name = place.name ?? ""

		return {
			wofID: place.id,
			name,
			placetype: place.placetype ?? "",
			countryCode,
			lon: place.longitude,
			lat: place.latitude,
			displayName: placeLabel({ name, placeID: `wof:${place.id}`, countryCode }, ancestorsOf),
		}
	}

	return {
		async page({ bbox, after, limit }) {
			const box = bbox ? { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] } : null

			return (await browser.page({ box, after, limit })).map(toItem)
		},
		async item(wofID) {
			const place = await browser.place(wofID)

			return place ? toItem(place) : null
		},
	}
}

/**
 * The gazetteer place ID of an item, the `id` of its feature and the `place_id` `/search` reports.
 */
export function itemPlaceID(item: Pick<OGCItem, "wofID">): string {
	return `wof:${item.wofID}`
}

/**
 * One item as a GeoJSON feature, with the links the caller supplies.
 */
export function itemFeature(item: OGCItem, links?: OGCItemFeature["links"]): OGCItemFeature {
	return {
		type: "Feature",
		id: itemPlaceID(item),
		geometry: { type: "Point", coordinates: [item.lon, item.lat] },
		properties: {
			name: item.name,
			placetype: item.placetype,
			country_code: item.countryCode,
			display_name: item.displayName,
		},
		...(links ? { links } : {}),
	}
}
