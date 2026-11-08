// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Refuses an address record whose point lies outside the bounding box of the subdivision it states.
 */

import { type LatLonBounds, latLonBoundsContain } from "@mailwoman/spatial/bbox"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import type { AddressRecord } from "#address/record"

/**
 * The reason a record outside its subdivision's box is refused under.
 */
export const OUTSIDE_SUBDIVISION = "outside-subdivision"

/**
 * A record check over one Who's On First admin database, closed on dispose.
 */
export interface SubdivisionBoundsCheck extends Disposable {
	/**
	 * Returns {@linkcode OUTSIDE_SUBDIVISION} for a record whose point lies outside
	 * the bounding box of its stated subdivision, or `null`.
	 *
	 * A record that states no subdivision, or whose subdivision the database
	 * holds no current region for, is kept.
	 */
	refuse(record: AddressRecord): string | null
	/**
	 * The subdivisions the database held no current region for, so their records went unchecked.
	 */
	readonly unchecked: ReadonlySet<string>
}

/**
 * Opens a check that reads each subdivision's box from a Who's On First admin database.
 *
 * The region is found by its `iso:code` concordance (`US-WI`), so the check reads
 * every country's subdivisions the same way.
 * Each box is read once and kept.
 */
export function openSubdivisionBoundsCheck(adminDatabasePath: PathBuilderLike): SubdivisionBoundsCheck {
	const db = new DatabaseClient<unknown>(adminDatabasePath, { readOnly: true })

	const read = db.prepare(
		`SELECT s.min_latitude AS minLat, s.max_latitude AS maxLat, s.min_longitude AS minLon, s.max_longitude AS maxLon
		 FROM concordances c JOIN spr s ON s.id = c.id
		 WHERE c.other_source = 'iso:code' AND c.other_id = ? AND s.placetype = 'region' AND s.is_current = 1
		 ORDER BY s.max_latitude - s.min_latitude DESC LIMIT 1`
	)

	const boxes = new Map<string, LatLonBounds | null>()
	const unchecked = new Set<string>()

	return {
		unchecked,
		refuse(record) {
			const subdivision = record.subdivision

			if (!subdivision) return null

			let box = boxes.get(subdivision)

			if (box === undefined) {
				box = (read.get(subdivision) as LatLonBounds | undefined) ?? null
				boxes.set(subdivision, box)

				if (!box) {
					unchecked.add(subdivision)
				}
			}

			if (!box) return null

			return latLonBoundsContain(box, record.lat, record.lon) ? null : OUTSIDE_SUBDIVISION
		},
		[Symbol.dispose]: () => db[Symbol.dispose](),
	}
}
