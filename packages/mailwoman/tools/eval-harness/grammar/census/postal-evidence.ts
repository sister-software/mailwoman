// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Postal evidence for a placetype-pair index entry, read from a GeoNames postal-code export.
 *
 * The export lists a place name for each postcode in about 100 countries.
 * The evidence asks whether the pair's child is the postcode place name at its own WOF location.
 *
 * That tells a postal locality from a district the post routes under another name.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { allRows } from "@mailwoman/core/utils"
import { nearestPostalPlace, postalGridCell } from "@mailwoman/gazetteer/tools/pipeline/pair/postal-children"
import { normalizeFSTToken } from "@mailwoman/neural/prior/fst"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"
import { TSVSpliterator } from "spliterator"

/**
 * One country's GeoNames postal place names, folded as the pair index folds its names.
 */
export interface PostalPlaces {
	artifact: string
	rows: number
	/**
	 * Postcode points bucketed by {@link postalGridCell}, each with its folded place name.
	 */
	grid: Map<string, Array<{ lat: number; lon: number; place: string }>>
	/**
	 * Folded place name to the first-level admin codes of the postcode rows that list it.
	 */
	placeAdmin1: Map<string, Set<string>>
	/**
	 * Folded place or admin name, of any level, to the first-level admin codes of its rows.
	 */
	anyNameAdmin1: Map<string, Set<string>>
}

const POSTAL_COLUMNS = 12

function addFolded(map: Map<string, Set<string>>, raw: string, admin1: string): void {
	const folded = normalizeFSTToken(raw.trim())

	if (!folded) return

	for (const key of new Set([folded, folded.replaceAll(" ", "")])) {
		let set = map.get(key)

		if (!set) {
			set = new Set()
			map.set(key, set)
		}

		set.add(admin1)
	}
}

/**
 * Reads `<CC>.txt`, else `<CC>.zip`, from a GeoNames postal directory.
 *
 * @throws When neither file exists, the file holds no records, or a record lacks the twelve columns.
 */
export async function readPostalPlaces(postalDir: string, country: string): Promise<PostalPlaces> {
	const cc = country.toUpperCase()
	const text = resolvePath(postalDir, `${cc}.txt`)
	const zip = resolvePath(postalDir, `${cc}.zip`)
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

	const placeAdmin1 = new Map<string, Set<string>>()
	const anyNameAdmin1 = new Map<string, Set<string>>()
	const grid: PostalPlaces["grid"] = new Map()
	let rows = 0

	for await (const columns of records) {
		rows++

		if (columns.length !== POSTAL_COLUMNS || columns[0] !== cc) {
			throw new Error(`GeoNames postal ${artifact} row ${rows}: expected ${cc} and ${POSTAL_COLUMNS} fields`)
		}

		const admin1 = columns[4]!.trim()

		addFolded(placeAdmin1, columns[2]!, admin1)

		for (const column of [2, 3, 5, 7]) {
			addFolded(anyNameAdmin1, columns[column]!, admin1)
		}

		const lat = Number(columns[9])
		const lon = Number(columns[10])
		const place = normalizeFSTToken(columns[2]!.trim())

		if (place && columns[9]!.trim() && columns[10]!.trim() && Number.isFinite(lat) && Number.isFinite(lon)) {
			const cell = postalGridCell(lat, lon)
			let bucket = grid.get(cell)

			if (!bucket) {
				bucket = []
				grid.set(cell, bucket)
			}

			bucket.push({ lat, lon, place })
		}
	}

	if (!rows) throw new Error(`GeoNames postal ${artifact} holds no records`)

	return { artifact, rows, placeAdmin1, anyNameAdmin1, grid }
}

interface PairLocation {
	id: number
	lat: number
	lon: number
	parentLat: number
	parentLon: number
}

/**
 * WOF child records keyed by folded `child\0parent`.
 */
export type ChildLocations = Map<string, PairLocation[]>

/**
 * Reads the WOF child records of one country with the ancestor join the pair builder uses.
 */
export function wofChildLocations(db: DatabaseClient<WOFDatabase>, country: string): ChildLocations {
	const rows = allRows<PairLocation & { child: string; parent: string }>(
		db.prepare(
			`SELECT s.id AS id, s.name AS child, p.name AS parent, s.latitude AS lat, s.longitude AS lon,
			        p.latitude AS parentLat, p.longitude AS parentLon
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

	const out: ChildLocations = new Map()

	for (const row of rows) {
		const child = normalizeFSTToken(row.child ?? "")

		if (!child) continue

		const key = `${child}\0${normalizeFSTToken(row.parent ?? "")}`
		const list = out.get(key) ?? []

		if (!list.some((record) => record.id === row.id)) {
			list.push({ id: row.id, lat: row.lat, lon: row.lon, parentLat: row.parentLat, parentLon: row.parentLon })
		}

		out.set(key, list)
	}

	return out
}

export interface PostalVerdict {
	/**
	 * The child is a postal place name somewhere in the country.
	 */
	loose: boolean
	/**
	 * A postcode row of the child shares a first-level admin code with a row listing the parent.
	 */
	scoped: boolean
	/**
	 * The folded place names of the postcode points nearest the WOF records of this pair.
	 * Null when no WOF record resolves the pair.
	 */
	nearest: string[] | null
	/**
	 * The child is the place name of the postcode nearest one of its WOF records.
	 * Null when no WOF record resolves the pair.
	 */
	atLocation: boolean | null
	/**
	 * The parent is the place name of the postcode nearest one of its WOF records.
	 * Null when no WOF record resolves the pair.
	 */
	parentAtLocation: boolean | null
	/**
	 * Whether the census treats the child as a postal locality.
	 *
	 * It is `atLocation`, and false where no WOF record resolves the pair.
	 *
	 * Name evidence without a location doesn't count: `brooklyn` is a postal place in Alabama,
	 * and a pair read from an address register already writes its child as an address line.
	 */
	postal: boolean
}

function listsPlace(places: readonly string[], name: string): boolean {
	const concat = name.replaceAll(" ", "")

	return places.some((place) => place === name || place.replaceAll(" ", "") === concat)
}

export function postalVerdict(
	postal: PostalPlaces,
	locations: ChildLocations,
	child: string,
	parent: string
): PostalVerdict {
	const childAdmins = postal.placeAdmin1.get(child)
	const parentAdmins = postal.anyNameAdmin1.get(parent)
	const loose = Boolean(childAdmins)
	const scoped = Boolean(childAdmins && parentAdmins && [...childAdmins].some((code) => parentAdmins.has(code)))
	const records = locations.get(`${child}\0${parent}`) ?? null

	if (!records) return { loose, scoped, nearest: null, atLocation: null, parentAtLocation: null, postal: false }

	const nearestTo = (points: Array<[number, number]>) => [
		...new Set(points.map(([lat, lon]) => nearestPostalPlace(postal, lat, lon) ?? "")),
	]

	const nearest = nearestTo(records.map((record) => [record.lat, record.lon]))
	const atLocation = listsPlace(nearest, child)
	const parentAtLocation = listsPlace(nearestTo(records.map((record) => [record.parentLat, record.parentLon])), parent)

	return { loose, scoped, nearest, atLocation, parentAtLocation, postal: atLocation }
}

/**
 * Pair counts by postal evidence.
 */
export interface EvidenceTally {
	pairs: number
	/**
	 * Distinct child names.
	 */
	children: number
	childrenLoose: number
	pairsLoose: number
	pairsScoped: number
	/**
	 * Pairs a WOF record resolves.
	 */
	pairsLocated: number
	/**
	 * Located pairs whose child is the place name of the postcode nearest it.
	 */
	pairsAtLocation: number
	/**
	 * Located pairs whose parent is the place name of the postcode nearest it.
	 */
	pairsParentAtLocation: number
	/**
	 * Pairs whose verdict is `postal`.
	 */
	pairsPostal: number
}

export class EvidenceCounter {
	readonly #children = new Set<string>()
	readonly #looseChildren = new Set<string>()

	readonly counts = {
		pairs: 0,
		pairsLoose: 0,
		pairsScoped: 0,
		pairsLocated: 0,
		pairsAtLocation: 0,
		pairsParentAtLocation: 0,
		pairsPostal: 0,
	}

	add(child: string, verdict: PostalVerdict): void {
		this.#children.add(child)

		this.counts.pairs++

		if (verdict.loose) {
			this.#looseChildren.add(child)

			this.counts.pairsLoose++
		}

		if (verdict.scoped) {
			this.counts.pairsScoped++
		}

		if (verdict.atLocation !== null) {
			this.counts.pairsLocated++
		}

		if (verdict.atLocation) {
			this.counts.pairsAtLocation++
		}

		if (verdict.postal) {
			this.counts.pairsPostal++
		}

		if (verdict.parentAtLocation) {
			this.counts.pairsParentAtLocation++
		}
	}

	tally(): EvidenceTally {
		return { ...this.counts, children: this.#children.size, childrenLoose: this.#looseChildren.size }
	}
}
