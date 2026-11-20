// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Pages through an admin gazetteer's current places in ascending id order, inside a bounding box.
 *
 *   A page continues after the last id the previous page returned, so the database seeks
 *   to it through the primary key and a deep page costs what the first page costs.
 *   The box selects a place by its point (`spr.latitude`, `spr.longitude`).
 *
 *   Two plans read a page, and the box decides between them.
 *
 *   - A box whose extent count in the `place_bbox` R*Tree is at most
 *     {@link EXTENT_PROBE_LIMIT} reads those places through the R*Tree, keeps the
 *     ones whose point lies inside the box, and sorts them by id.
 *     The cost is the box's extent count and doesn't depend on the page's position.
 *   - A larger box walks `spr` in primary-key order from the cursor and stops at the page's last row.
 *     Such a box holds enough places that the walk ends early, and it never reads more than the table once.
 *
 *   The R*Tree indexes each place's extent rather than its point.
 *   A place without a recorded extent has no R*Tree row, and some places record
 *   a point outside their own extent.
 *
 *   The R*Tree plan would miss both, so the browser reads those places once,
 *   on first use, and adds the ones inside the box.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { type LatLonBounds, latLonBoundsContain } from "@mailwoman/spatial/bbox"
import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"
import { sql } from "kysely"

import { PLACE_BBOX_TABLE } from "#fts"
import type { SprTable, WOFDatabase } from "#schema"
import { hasTable } from "#sqlite-utils"

/**
 * The `place_bbox` R*Tree `fts.ts` builds: one row per current place with a recorded extent.
 */
export interface PlaceBBoxTable {
	id: number
	min_lat: number
	max_lat: number
	min_lon: number
	max_lon: number
}

/**
 * The tables the browser reads.
 */
export interface PlaceBrowseDatabase {
	spr: WOFDatabase["spr"]
	[PLACE_BBOX_TABLE]: PlaceBBoxTable
}

/**
 * One current place, as a page returns it.
 */
export type BrowsedPlace = Pick<SprTable, "id" | "name" | "placetype" | "country" | "latitude" | "longitude">

/**
 * A box in WGS 84 degrees.
 *
 * A minimum longitude above the maximum crosses the antimeridian.
 */
export type BrowseBox = LatLonBounds

/**
 * One page request.
 */
export interface BrowsePageRequest {
	/**
	 * The box a place's point must lie in, or null for every place.
	 */
	box: BrowseBox | null
	/**
	 * Return only places whose id exceeds this one, or null to start at the first place.
	 */
	after: number | null
	limit: number
}

/**
 * The most R*Tree extents a box may intersect for its page to be read through the R*Tree,
 * unless {@link WOFPlaceBrowserOptions.extentProbeLimit} sets another.
 *
 * It chooses a plan and decides no result.
 * Both plans return the same rows, because each selects a place by its point.
 */
const EXTENT_PROBE_LIMIT = 50_000

/**
 * Where a {@link WOFPlaceBrowser} reads from, and when it reads a page through the R*Tree.
 */
export interface WOFPlaceBrowserOptions extends SQLiteLookupOptions<PlaceBrowseDatabase> {
	/**
	 * The most R*Tree extents a box may intersect for its page to be read through the R*Tree.
	 *
	 * @defaultValue 50,000. On `admin-global-priority.db`, a page of up to 1001 places took at most 40 ms
	 * through either plan with this limit, the probe included (measured on #3142).
	 */
	extentProbeLimit?: number
}

/**
 * The candidates read past a page's limit in one query of the R*Tree plan,
 * for the few whose extent meets the box while their point lies outside it.
 */
const PAGE_CHUNK_MARGIN = 64

const COLUMNS = ["id", "name", "placetype", "country", "latitude", "longitude"] as const

/**
 * A place the R*Tree plan can't find through the R*Tree.
 */
interface IrregularPlace {
	id: number
	latitude: number
	longitude: number
}

/**
 * The box split at the antimeridian into boxes whose minimum longitude doesn't exceed the maximum.
 */
function unwrappedBoxes(box: BrowseBox): BrowseBox[] {
	if (box.minLon <= box.maxLon) return [box]

	return [
		{ ...box, maxLon: 180 },
		{ ...box, minLon: -180 },
	]
}

/**
 * Whether a point lies inside the box, edges included, across the antimeridian too.
 */
function boxContains(box: BrowseBox, latitude: number, longitude: number): boolean {
	return unwrappedBoxes(box).some((part) => latLonBoundsContain(part, latitude, longitude))
}

/**
 * Pages through the current places of an admin gazetteer such as `admin-global-priority.db`.
 *
 * A place is current when `is_current != 0` and `is_deprecated = 0`,
 * the filter the resolver and the R*Tree build apply.
 */
export class WOFPlaceBrowser extends SQLiteLookup<PlaceBrowseDatabase> {
	#irregular: Promise<IrregularPlace[]> | undefined
	readonly #extentProbeLimit: number

	/**
	 * @throws When the database lacks `spr` or the `place_bbox` R*Tree, because it can't answer a box page.
	 */
	constructor({ extentProbeLimit = EXTENT_PROBE_LIMIT, ...options }: WOFPlaceBrowserOptions) {
		super(options)

		this.#extentProbeLimit = extentProbeLimit

		for (const table of ["spr", PLACE_BBOX_TABLE]) {
			if (!hasTable(this.database, table)) {
				this[Symbol.dispose]()

				throw new Error(`the database has no ${table} table`)
			}
		}
	}

	#current() {
		return this.database
			.selectFrom("spr")
			.select(COLUMNS)
			.where("spr.is_current", "!=", 0)
			.where("spr.is_deprecated", "=", 0)
	}

	/**
	 * The current place with this id, or null when the gazetteer holds no current place with it.
	 */
	async place(id: number): Promise<BrowsedPlace | null> {
		return (await this.#current().where("spr.id", "=", id).executeTakeFirst()) ?? null
	}

	/**
	 * The current places the request selects, in ascending id order, at most `limit` of them.
	 */
	async page({ box, after, limit }: BrowsePageRequest): Promise<BrowsedPlace[]> {
		if (box) {
			const extentIDs = await this.#extentsIntersecting(box)

			if (extentIDs) return this.#pageThroughExtents(box, extentIDs, after, limit)
		}

		let query = this.#current()
			.where("spr.id", ">", after ?? Number.MIN_SAFE_INTEGER)
			.orderBy("spr.id")
			.limit(limit)

		if (box) {
			query = query
				.where("spr.latitude", ">=", box.minLat)
				.where("spr.latitude", "<=", box.maxLat)
				.where((eb) =>
					box.minLon <= box.maxLon
						? eb.and([eb("spr.longitude", ">=", box.minLon), eb("spr.longitude", "<=", box.maxLon)])
						: eb.or([eb("spr.longitude", ">=", box.minLon), eb("spr.longitude", "<=", box.maxLon)])
				)
		}

		return query.execute()
	}

	/**
	 * The ids of the R*Tree extents the box intersects, or null when they exceed the probe limit.
	 */
	async #extentsIntersecting(box: BrowseBox): Promise<Set<number> | null> {
		const ids = new Set<number>()

		for (const part of unwrappedBoxes(box)) {
			const rows = await this.database
				.selectFrom(PLACE_BBOX_TABLE)
				.select("id")
				.where("min_lon", "<=", part.maxLon)
				.where("max_lon", ">=", part.minLon)
				.where("min_lat", "<=", part.maxLat)
				.where("max_lat", ">=", part.minLat)
				.limit(this.#extentProbeLimit + 1 - ids.size)
				.execute()

			for (const { id } of rows) {
				ids.add(id)
			}

			if (ids.size > this.#extentProbeLimit) return null
		}

		return ids
	}

	async #pageThroughExtents(
		box: BrowseBox,
		extentIDs: Set<number>,
		after: number | null,
		limit: number
	): Promise<BrowsedPlace[]> {
		const candidates = new Set<number>()

		for (const id of extentIDs) {
			if (after == null || id > after) {
				candidates.add(id)
			}
		}

		for (const place of await this.#irregularPlaces()) {
			if ((after == null || place.id > after) && boxContains(box, place.latitude, place.longitude)) {
				candidates.add(place.id)
			}
		}

		// A candidate's extent meets the box, and its point lies inside unless the extent crosses an edge.
		// A chunk past the limit therefore holds the page in the common case.
		const ordered = [...candidates].toSorted((a, b) => a - b)
		const page: BrowsedPlace[] = []
		const chunk = limit + PAGE_CHUNK_MARGIN

		for (let start = 0; start < ordered.length && page.length < limit; start += chunk) {
			const ids = ordered.slice(start, start + chunk)

			const rows = await this.#current()
				.where("spr.id", "in", sql<number>`(SELECT value FROM json_each(${stringifyJSON(ids)}))`)
				.orderBy("spr.id")
				.execute()

			for (const row of rows) {
				if (page.length < limit && boxContains(box, row.latitude, row.longitude)) {
					page.push(row)
				}
			}
		}

		return page
	}

	/**
	 * The current places the R*Tree plan can't reach through `place_bbox`, read once.
	 *
	 * The first group is the places the R*Tree build skipped: a null extent,
	 * or the all-zero extent it treats as none.
	 * The second is the places whose point lies outside their own extent.
	 */
	#irregularPlaces(): Promise<IrregularPlace[]> {
		this.#irregular ??= this.database
			.selectFrom("spr")
			.select(["id", "latitude", "longitude"])
			.where("spr.is_current", "!=", 0)
			.where("spr.is_deprecated", "=", 0)
			.where(
				sql<boolean>`(spr.min_latitude IS NULL OR spr.max_latitude IS NULL OR spr.min_longitude IS NULL OR spr.max_longitude IS NULL
					OR (spr.min_latitude = 0 AND spr.max_latitude = 0 AND spr.min_longitude = 0 AND spr.max_longitude = 0)
					OR spr.longitude < spr.min_longitude OR spr.longitude > spr.max_longitude
					OR spr.latitude < spr.min_latitude OR spr.latitude > spr.max_latitude)`
			)
			.execute()

		return this.#irregular
	}
}
