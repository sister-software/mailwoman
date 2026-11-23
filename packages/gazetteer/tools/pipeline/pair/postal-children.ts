// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The postal-child test of #3165 for a placetype-pair index entry, read from a GeoNames postal-code export.
 *
 * An entry's child is a postal child when it's the place name of the postcode point
 * nearest one of its own WOF records, such as `brooklyn / new york`.
 * The post routes such a child as a locality, so the pair index leaves the entry out
 * rather than bias it toward `dependent_locality`.
 *
 * Name evidence without a location is too weak: `brooklyn / atlanta` matches a postcode
 * place name in Georgia, and the nearest postcode to its own WOF record names another place.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { allRows } from "@mailwoman/core/utils"
import type { PairIndexEntry } from "@mailwoman/neural/pair"
import { normalizeFSTToken } from "@mailwoman/neural/prior/fst"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath, type PathBuilderLike } from "path-ts"
import { TSVSpliterator } from "spliterator"

/**
 * Column count of a GeoNames postal-code row: country, postcode, place, three admin name
 * and code pairs, latitude, longitude and accuracy.
 */
const POSTAL_COLUMNS = 12

/**
 * The grid cell size, in degrees, the postcode points are bucketed by.
 */
const GRID_DEGREES = 0.1

/**
 * The ring search stops at 10 cells, about 110 km at {@link GRID_DEGREES}.
 */
const MAX_RING = 10

/**
 * One country's GeoNames postcode points, each with its folded place name, bucketed by grid cell.
 */
export interface PostalPoints {
	/**
	 * The file the points were read from.
	 */
	artifact: string
	rows: number
	grid: Map<string, Array<{ lat: number; lon: number; place: string }>>
}

const gridKey = (row: number, column: number): string => `${row},${column}`

/**
 * The grid cell a postcode point is bucketed under, the key {@link nearestPostalPlace} searches.
 */
export function postalGridCell(lat: number, lon: number): string {
	return gridKey(Math.floor(lat / GRID_DEGREES), Math.floor(lon / GRID_DEGREES))
}

/**
 * Reads `<CC>.txt`, else `<CC>.zip`, from a GeoNames postal directory.
 *
 * @throws When neither file exists, the file holds no records, or a record lacks the twelve columns.
 */
export async function readPostalPoints(postalDirectory: PathBuilderLike, country: string): Promise<PostalPoints> {
	const cc = country.toUpperCase()
	const text = resolvePath(postalDirectory, `${cc}.txt`)
	const zip = resolvePath(postalDirectory, `${cc}.zip`)
	let artifact: string
	let records: AsyncIterable<string[]>

	if (await pathExists(text)) {
		artifact = text.toString()
		records = readUnquotedTSV(text)
	} else if (await pathExists(zip)) {
		artifact = zip.toString()

		records = TSVSpliterator.fromAsync(readZipEntry(zip, `${cc}.txt`), {
			header: false,
			enableQuoteHandling: false,
		}) as AsyncIterable<string[]>
	} else {
		throw new Error(`GeoNames postal ${cc}: neither ${text} nor ${zip} exists`)
	}

	const grid: PostalPoints["grid"] = new Map()
	let rows = 0

	for await (const columns of records) {
		rows++

		if (columns.length !== POSTAL_COLUMNS || columns[0] !== cc) {
			throw new Error(`GeoNames postal ${artifact} row ${rows}: expected ${cc} and ${POSTAL_COLUMNS} fields`)
		}

		const place = normalizeFSTToken(columns[2]!.trim())
		const lat = Number(columns[9])
		const lon = Number(columns[10])

		if (!place || !columns[9]!.trim() || !columns[10]!.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			continue
		}

		const cell = postalGridCell(lat, lon)
		let bucket = grid.get(cell)

		if (!bucket) {
			bucket = []
			grid.set(cell, bucket)
		}

		bucket.push({ lat, lon, place })
	}

	if (!rows) throw new Error(`GeoNames postal ${artifact} holds no records`)

	return { artifact, rows, grid }
}

/**
 * The folded place name of the postcode point nearest `(lat, lon)`, by squared equirectangular distance.
 *
 * Null when no point lies within {@link MAX_RING} cells.
 */
export function nearestPostalPlace(postal: Pick<PostalPoints, "grid">, lat: number, lon: number): string | null {
	const row = Math.floor(lat / GRID_DEGREES)
	const column = Math.floor(lon / GRID_DEGREES)
	const scale = Math.cos((lat * Math.PI) / 180)
	let best: string | null = null
	let bestDistance = Number.POSITIVE_INFINITY

	for (let ring = 0; ring <= MAX_RING; ring++) {
		for (let dr = -ring; dr <= ring; dr++) {
			for (let dc = -ring; dc <= ring; dc++) {
				if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue

				for (const point of postal.grid.get(gridKey(row + dr, column + dc)) ?? []) {
					const distance = (point.lat - lat) ** 2 + ((point.lon - lon) * scale) ** 2

					if (distance < bestDistance) {
						bestDistance = distance
						best = point.place
					}
				}
			}
		}

		// Every point beyond this ring is at least `ring` cells away in latitude or scaled longitude.
		if (best !== null && Math.sqrt(bestDistance) <= ring * GRID_DEGREES * Math.min(1, scale)) break
	}

	return best
}

/**
 * The WOF record points of each pair's child, keyed by folded `child\0parent`.
 */
export type ChildLocations = Map<string, Array<{ id: number; lat: number; lon: number }>>

/**
 * Reads the WOF child records of one country, joined to their ancestors as the census of #3165 joined them.
 */
export function readChildLocations(adminDBPath: PathBuilderLike, country: string): ChildLocations {
	const db = new DatabaseClient<WOFDatabase>(adminDBPath.toString(), { readOnly: true })

	try {
		const rows = allRows<{ id: number; child: string; parent: string; lat: number; lon: number }>(
			db.prepare(
				`SELECT s.id AS id, s.name AS child, p.name AS parent, s.latitude AS lat, s.longitude AS lon
				 FROM spr s
				 JOIN ancestors a ON a.id = s.id
				 JOIN spr p ON p.id = a.ancestor_id
				 WHERE s.placetype IN ('borough', 'neighbourhood', 'macrohood')
				   AND p.placetype IN ('locality', 'localadmin', 'borough', 'macrohood')
				   AND s.country = ?
				   AND p.country = s.country
				   AND s.is_current != 0 AND s.is_deprecated = 0
				   AND p.is_current != 0 AND p.is_deprecated = 0`
			),
			country.toUpperCase()
		)

		const locations: ChildLocations = new Map()

		for (const row of rows) {
			const child = normalizeFSTToken(row.child ?? "")

			if (!child) continue

			const key = `${child}\0${normalizeFSTToken(row.parent ?? "")}`
			const list = locations.get(key) ?? []

			if (!list.some((record) => record.id === row.id)) {
				list.push({ id: row.id, lat: row.lat, lon: row.lon })
			}

			locations.set(key, list)
		}

		return locations
	} finally {
		db.destroy()
	}
}

/**
 * Whether two folded names are the same place name, with or without their spaces.
 */
function sameFoldedName(a: string, b: string): boolean {
	return a === b || a.replaceAll(" ", "") === b.replaceAll(" ", "")
}

/**
 * Whether `child`, a folded name, is the place name of the postcode point nearest one of its WOF records.
 *
 * A child no record locates isn't postal at its location, since a name without a
 * location doesn't separate a postal locality from a namesake.
 */
export function isPostalAtLocation(
	postal: Pick<PostalPoints, "grid">,
	records: ReadonlyArray<{ lat: number; lon: number }>,
	child: string
): boolean {
	return records.some((record) => {
		const nearest = nearestPostalPlace(postal, record.lat, record.lon)

		return nearest !== null && sameFoldedName(nearest, child)
	})
}

/**
 * Whether a sub-locality pair `<child>, <parent>` reads as `locality: child, region: parent`
 * rather than `dependent_locality: child, locality: parent`.
 *
 * Both must hold:
 *
 * - the child is the postal place at its own location ({@linkcode isPostalAtLocation}), and
 * - the parent's name is also the name of a first-level WOF region of the same
 *   country, one of `regionNames`.
 *
 * `Brooklyn, New York` reads as a locality and its region.
 * `Park Slope, Brooklyn` (the nearest postcode names Brooklyn) and `Venice, Los Angeles`
 * (WOF records no region called Los Angeles) keep the dependent-locality reading.
 * Every name is folded by `normalizeFSTToken`.
 */
export function isPostalLocalityPair(
	postal: Pick<PostalPoints, "grid">,
	records: ReadonlyArray<{ lat: number; lon: number }>,
	pair: { child: string; parent: string },
	regionNames: ReadonlySet<string>
): boolean {
	return regionNames.has(pair.parent) && isPostalAtLocation(postal, records, pair.child)
}

/**
 * Whether an entry's child is the place name of the postcode nearest one of its WOF records.
 */
function isPostalChild(
	postal: Pick<PostalPoints, "grid">,
	locations: ChildLocations,
	entry: Pick<PairIndexEntry, "child" | "parent">
): boolean {
	return isPostalAtLocation(postal, locations.get(`${entry.child}\0${entry.parent}`) ?? [], entry.child)
}

/**
 * Splits entries into those the index keeps and the postal children it leaves out.
 */
export function partitionPostalChildren<Entry extends Pick<PairIndexEntry, "child" | "parent">>(
	entries: readonly Entry[],
	postal: Pick<PostalPoints, "grid">,
	locations: ChildLocations
): { kept: Entry[]; dropped: Entry[] } {
	const kept: Entry[] = []
	const dropped: Entry[] = []

	for (const entry of entries) {
		if (isPostalChild(postal, locations, entry)) {
			dropped.push(entry)
		} else {
			kept.push(entry)
		}
	}

	return { kept, dropped }
}
