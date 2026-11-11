/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The inventory: the ranked entities that are places, with their country codes, and the counts by country
 * and by class that size the training source.
 */

import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"

import {
	type ClassRoots,
	PLACE_VERDICTS,
	type PlaceVerdict,
	placeVerdict,
} from "#tools/fetch/wikidata/vital-places/classify"
import { isVitalEntity, type VitalEntity, type VitalEntityRecord } from "#tools/fetch/wikidata/vital-places/entities"

/**
 * One line of the places file: a kept entity with the codes of its countries.
 */
export interface VitalPlace extends VitalEntity {
	/**
	 * The ISO 3166-1 alpha-2 codes of the `P17` countries that state one, in claim order.
	 */
	countryCodes: string[]
}

/**
 * Why a ranked record isn't in the places file.
 */
export const EXCLUSION_REASONS = {
	missing: "missing",
	noCoordinate: "no-coordinate",
	excluded: PLACE_VERDICTS.excluded,
	unclassified: PLACE_VERDICTS.unclassified,
} as const

export type ExclusionReason = (typeof EXCLUSION_REASONS)[keyof typeof EXCLUSION_REASONS]

/**
 * The counts written beside the places file.
 */
export interface VitalPlaceCounts {
	records: number
	places: number
	excluded: Record<ExclusionReason, number>
	/**
	 * Places per country code; `??` counts a place whose countries state no code or that has no country.
	 */
	byCountry: Record<string, number>
	/**
	 * Places per `P31` class id, a place with several classes counted under each.
	 */
	byClass: Record<string, number>
}

/**
 * The code every place without one is counted under.
 */
export const UNKNOWN_COUNTRY = "??"

/**
 * The inventory built from the records, the class roots and the country codes.
 */
export interface VitalInventory {
	places: VitalPlace[]
	counts: VitalPlaceCounts
}

/**
 * Sort the kept places and count them.
 *
 * A record is a place when it has a coordinate on Earth and {@linkcode placeVerdict}
 * answers `place` for its classes.
 * The counts record every other record under its reason, so the file's totals reconcile with the list.
 */
export function buildInventory(
	records: readonly VitalEntityRecord[],
	roots: Readonly<ClassRoots>,
	countryCodes: Readonly<Record<string, string | null>>
): VitalInventory {
	const places: VitalPlace[] = []
	const excluded: Record<ExclusionReason, number> = { missing: 0, "no-coordinate": 0, excluded: 0, unclassified: 0 }
	const byCountry: Record<string, number> = {}
	const byClass: Record<string, number> = {}

	for (const record of records) {
		if (!isVitalEntity(record)) {
			excluded.missing++

			continue
		}

		if (!record.coordinate) {
			excluded["no-coordinate"]++

			continue
		}

		const verdict: PlaceVerdict = placeVerdict(record.classes, roots)

		if (verdict !== PLACE_VERDICTS.place) {
			excluded[verdict]++

			continue
		}

		const codes = record.countries
			.map((id) => countryCodes[id] ?? null)
			.filter((code): code is string => typeof code === "string")

		places.push({ ...record, countryCodes: codes })

		for (const code of codes.length ? codes : [UNKNOWN_COUNTRY]) {
			byCountry[code] = (byCountry[code] ?? 0) + 1
		}

		for (const cls of record.classes) {
			byClass[cls] = (byClass[cls] ?? 0) + 1
		}
	}

	places.sort((left, right) => right.qrank - left.qrank)

	return {
		places,
		counts: {
			records: records.length,
			places: places.length,
			excluded,
			byCountry: sortedByCount(byCountry),
			byClass: sortedByCount(byClass),
		},
	}
}

function sortedByCount(counts: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).toSorted((left, right) => right[1] - left[1]))
}

/**
 * Write the places as JSONL and the counts as JSON.
 */
export async function writeInventory(
	inventory: VitalInventory,
	placesPath: PathBuilderLike,
	countsPath: PathBuilderLike
): Promise<void> {
	await writeLocalJSONLFile(inventory.places, placesPath)
	await writeLocalJSONFile(inventory.counts, countsPath)
}
