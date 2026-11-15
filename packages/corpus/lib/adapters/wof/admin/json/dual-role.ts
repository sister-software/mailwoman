// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The `wof-admin` rule for a region that shares its name with the city inside it (Berlin, Zürich, Madrid).
 *
 *   In the two-part form `<name>, <country>`, the shared name reads as the city: `Berlin, Germany` is the city. The
 *   adapter therefore leaves out the region's `<region>, <country>` rows and keeps the city's `<locality>, <country>`
 *   row whatever the sample would keep (#2909).
 *
 *   A region qualifies when it holds a same-name locality near its centroid, and that locality is a seat in the
 *   capitals reference for the country or the most populous locality inside the region. The pair test is the one the
 *   gazetteer's coincident-roles relation used, with the names compared without case or diacritics: the canton
 *   `Zurich` holds the city `Zürich`. The locality descends from the region, and the centroids lie within 15% of the
 *   region's bounding-box diagonal, or within 12 km.
 */

import { foldToken } from "@mailwoman/codex/normalize"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import type { PathBuilderLike } from "path-ts"

import type { WOFRowRule } from "#adapters/wof/json-rows"
import type { CanonicalRow } from "#types"
import type { WOFRecord } from "#utils"

/**
 * The share of a region's bounding-box diagonal its same-name locality's centroid may lie from the region's.
 */
const TOLERANCE_FRACTION = 0.15

/**
 * The distance a pair is always admitted within, so a small city-state (Bremen, 9.3 km apart) still pairs.
 */
const MIN_TOLERANCE_KM = 12

/**
 * The number of values in a 2D bounding box: `[west, south, east, north]`.
 */
const BBOX_2D_LENGTH = 4

/**
 * The key two spellings of one place name share: diacritics and case removed, ends trimmed.
 */
function dualRoleKey(name: string): string {
	return foldToken(name).trim()
}

/**
 * One region or locality as the rule reads it.
 */
export interface DualRolePlace {
	id: number
	name: string
	placetype: string
	country: string
	/**
	 * Ancestor ids, nearest first.
	 */
	ancestors: readonly number[]
	latitude: number
	longitude: number
	/**
	 * `[west, south, east, north]`, or `null` when the record states none.
	 */
	bbox: readonly [number, number, number, number] | null
	population: number
}

/**
 * The rule's view of a stored record: its label point, else its geometry point, else `0, 0`;
 * its `geom:bbox`; and `wof:population`, else `gn:population`, else 0.
 *
 * The gazetteer's admin build reads a record's point and population the same way.
 */
export function dualRolePlaceOf(record: WOFRecord, properties: Record<string, unknown>): DualRolePlace {
	const number = (key: string): number | null => {
		const value = properties[key]

		return typeof value === "number" && Number.isFinite(value) ? value : null
	}

	const lbl = [number("lbl:latitude"), number("lbl:longitude")] as const
	const geom = [number("geom:latitude"), number("geom:longitude")] as const
	const point = lbl.every((n) => n != null) ? lbl : geom.every((n) => n != null) ? geom : [0, 0]
	const bboxText = properties["geom:bbox"]
	const bboxParts = typeof bboxText === "string" ? bboxText.split(",").map(Number) : []

	return {
		id: record.id,
		name: record.name,
		placetype: record.placetype,
		country: record.country,
		ancestors: record.parent_id != null ? [...record.ancestors, record.parent_id] : record.ancestors,
		latitude: point[0]!,
		longitude: point[1]!,
		bbox:
			bboxParts.length === BBOX_2D_LENGTH && bboxParts.every((n) => Number.isFinite(n))
				? (bboxParts as [number, number, number, number])
				: null,
		population: number("wof:population") ?? number("gn:population") ?? 0,
	}
}

/**
 * Why a region's locality qualifies.
 */
export const DualRoleBasis = { seat: "seat", largest: "largest" } as const

export type DualRoleBasis = (typeof DualRoleBasis)[keyof typeof DualRoleBasis]

/**
 * A region and the same-name locality whose name it yields.
 */
export interface DualRolePair {
	regionID: number
	localityID: number
	country: string
	name: string
	basis: DualRoleBasis
}

/**
 * The seats of the capitals reference, as `<country>|<folded name>` for each
 * entry's name and each of its keys.
 */
export type CapitalSeats = ReadonlySet<string>

/**
 * The capitals reference `mailwoman gazetteer capitals` writes, from GeoNames'
 * national capitals and admin-1 seats.
 */
export function capitalsReferencePath(): string {
	return repoRootPath("data", "gazetteer", "capitals-v1.json")
}

/**
 * The seats {@linkcode capitalsReferencePath} lists.
 *
 * @throws When the file isn't a version 1 reference with entries, because an empty seat
 * set would qualify only the largest localities and look like a valid result.
 */
export async function readCapitalSeats(path: PathBuilderLike = capitalsReferencePath()): Promise<CapitalSeats> {
	const parsed = await readLocalJSONFile<{
		version?: number
		entries?: Array<{ name?: string; country?: string; k?: string[] }>
	}>(path)

	if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.length) {
		throw new Error(`${path.toString()} is not a version 1 capitals reference with entries.`)
	}

	const seats = new Set<string>()

	for (const entry of parsed.entries) {
		if (!entry.country) continue

		for (const name of [entry.name, ...(entry.k ?? [])]) {
			if (name) {
				seats.add(`${entry.country.toUpperCase()}|${dualRoleKey(name)}`)
			}
		}
	}

	return seats
}

/**
 * The qualifying pairs of `regions` and `localities`, which must hold every region
 * and locality the rule may pair.
 *
 * The regions are held, and the localities are read once, as they stream past.
 *
 * A region's largest locality is the one with the highest population that descends
 * from it, the lower id first on a tie.
 * A region whose localities state no population has no largest locality, so only a seat qualifies it.
 */
export function findDualRolePairs(
	regionPlaces: Iterable<DualRolePlace>,
	localities: Iterable<DualRolePlace>,
	seats: CapitalSeats
): DualRolePair[] {
	const regions = new Map<number, DualRolePlace>()

	for (const region of regionPlaces) {
		regions.set(region.id, region)
	}

	const largest = new Map<number, DualRolePlace>()
	const candidates: Array<{ region: DualRolePlace; locality: DualRolePlace }> = []

	for (const locality of localities) {
		for (const regionID of new Set(locality.ancestors)) {
			const region = regions.get(regionID)

			if (!region) continue

			const held = largest.get(regionID)

			if (
				locality.population > 0 &&
				(!held ||
					locality.population > held.population ||
					(locality.population === held.population && locality.id < held.id))
			) {
				largest.set(regionID, locality)
			}

			if (dualRoleKey(locality.name) === dualRoleKey(region.name) && isCoincident(region, locality)) {
				candidates.push({ region, locality })
			}
		}
	}

	const pairs: DualRolePair[] = []

	for (const { region, locality } of candidates) {
		const basis = seats.has(`${locality.country}|${dualRoleKey(locality.name)}`)
			? DualRoleBasis.seat
			: largest.get(region.id)?.id === locality.id
				? DualRoleBasis.largest
				: null

		if (basis) {
			pairs.push({ regionID: region.id, localityID: locality.id, country: region.country, name: region.name, basis })
		}
	}

	return pairs.toSorted((a, b) => a.regionID - b.regionID || a.localityID - b.localityID)
}

/**
 * Whether a locality's centroid lies within the region's tolerance of the region's centroid.
 */
function isCoincident(region: DualRolePlace, locality: DualRolePlace): boolean {
	const distance = haversine(region.latitude, region.longitude, locality.latitude, locality.longitude)

	const [west, south, east, north] = region.bbox ?? [
		region.longitude,
		region.latitude,
		region.longitude,
		region.latitude,
	]

	const diagonal = haversine(south, west, north, east)

	return distance <= Math.max(TOLERANCE_FRACTION * diagonal, MIN_TOLERANCE_KM)
}

/**
 * The row rule for `pairs`: a `<region>, <country>` row whose region folds to a paired
 * region's name in the row's country is left out, whichever record or name slot wrote it,
 * and each paired locality's canonical `<locality>, <country>` row is required.
 */
export function dualRoleRowRule(adapterID: string, pairs: readonly DualRolePair[]): WOFRowRule {
	const regionNames = new Set(pairs.map((pair) => `${pair.country}|${dualRoleKey(pair.name)}`))
	const required = new Set(pairs.map((pair) => `${adapterID}-${pair.localityID}-default-with-country`))

	return {
		drops: (row: CanonicalRow) => {
			const tags = Object.keys(row.components)
			const region = row.components.region

			return (
				tags.length === 2 &&
				typeof region === "string" &&
				typeof row.components.country === "string" &&
				regionNames.has(`${row.country}|${dualRoleKey(region)}`)
			)
		},
		requires: (row: CanonicalRow) => required.has(row.source_id),
	}
}
