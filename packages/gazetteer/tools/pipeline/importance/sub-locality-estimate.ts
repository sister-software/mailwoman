// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A population estimate for each sub-locality the admin database records no population for.
 *
 *   The candidate table ranks a `borough`, `macrohood`, `neighbourhood` or `microhood`
 *   with no `wof:population` at the bottom of its name key.
 *   The estimate splits the containing settlement's population evenly among the places of the same
 *   placetype it contains, with one extra share for the part of the settlement no recorded child covers:
 *
 *       estimate(x) = base(parent(x)) / (siblings(x) + 1)
 *
 *   `base(p)` is the parent's measured population, or its own estimate
 *   when the parent is an unmeasured sub-locality.
 *   A parent outside the settlement placetypes (a county, a region) gives no estimate,
 *   so a neighborhood is never handed a share of a region.
 *
 *   The rule reads only the WOF hierarchy and `place_population`, the same tables for every country.
 *
 *   A sub-locality whose measured population is at least its parent's base records
 *   the whole settlement's figure rather than its own, so that figure is neither
 *   divided among its children nor used to calibrate the estimate.
 *   The extra share makes every estimate strictly smaller than the base it divides,
 *   so a sub-locality never outranks the settlement that contains it.
 *
 *   An estimate is uncertain where a measurement isn't, so it ranks by its lower decile:
 *   the point estimate scaled by the 10th percentile of measured / estimate over every
 *   measured sub-locality the build could also have estimated.
 *
 *   The build measures that percentile on each run rather than storing a constant.
 */

import { percentile } from "@mailwoman/core/math/stats"
import { isOverturePartID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { allRows } from "@mailwoman/core/utils"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

import { SETTLEMENT_PLACETYPES, SUB_LOCALITY_PLACETYPES } from "#whosonfirst/placetypes/specificity"

/**
 * One current place as the estimator reads it.
 */
export interface HierarchyPlace {
	id: number
	placetype: string
	parentID: number
	/**
	 * The measured population, or null when the admin database records none.
	 */
	population: number | null
}

/**
 * One estimated sub-locality population.
 */
export interface SubLocalityEstimate {
	id: number
	/**
	 * The point estimate.
	 */
	population: number
	/**
	 * The point estimate scaled by the calibration's lower decile, the value the candidate table ranks by.
	 */
	rankPopulation: number
	parentID: number
	siblings: number
}

/**
 * How the estimate compares with measured populations, over every sub-locality
 * that has one and could also have been estimated.
 */
export interface SubLocalityCalibration {
	/**
	 * The count of measured sub-localities compared.
	 */
	compared: number
	/**
	 * The 10th, 50th and 90th percentiles of log10(measured / estimate).
	 */
	p10: number
	p50: number
	p90: number
	/**
	 * The factor a point estimate is multiplied by to give its ranking population: `10 ** min(p10, 0)`.
	 */
	rankFactor: number
}

/**
 * What {@link estimateFromHierarchy} counted.
 *
 * `measured + estimated + unestimable` equals `subLocalities`.
 */
export interface SubLocalityEstimateStats {
	subLocalities: number
	measured: number
	/**
	 * Measured sub-localities whose figure is at least their parent's base, read as the settlement's.
	 */
	measuredAsWhole: number
	estimated: number
	/**
	 * Sub-localities with no population and no settlement ancestor with one to divide.
	 */
	unestimable: number
}

/**
 * The result of {@link estimateFromHierarchy}.
 *
 * `calibration` is null, and `estimates` empty, when no measured sub-locality could be compared.
 */
export interface SubLocalityEstimates {
	estimates: SubLocalityEstimate[]
	calibration: SubLocalityCalibration | null
	stats: SubLocalityEstimateStats
}

const LOWER_DECILE = 10

/**
 * Estimates the population of each unmeasured sub-locality in `places`.
 *
 * `places` holds the sub-localities and the settlements that contain them.
 * Any other place may be present and is read only as a parent.
 * A cycle in `parentID` gives the places on it no estimate.
 */
export function estimateFromHierarchy(places: Iterable<HierarchyPlace>): SubLocalityEstimates {
	const byID = new Map<number, HierarchyPlace>()
	const siblings = new Map<string, number>()
	const familyKey = (parentID: number, placetype: string): string => `${parentID}\u0000${placetype}`

	for (const place of places) {
		byID.set(place.id, place)

		if (SUB_LOCALITY_PLACETYPES.has(place.placetype)) {
			const key = familyKey(place.parentID, place.placetype)
			siblings.set(key, (siblings.get(key) ?? 0) + 1)
		}
	}

	const measuredOf = (place: HierarchyPlace): number | null =>
		typeof place.population === "number" && place.population > 0 ? place.population : null

	const familySize = (place: HierarchyPlace): number => siblings.get(familyKey(place.parentID, place.placetype)) ?? 1

	// A key absent from a memo hasn't been computed.
	// A null is computed with no value, or on the current walk.
	const estimateMemo = new Map<number, number | null>()
	const baseMemo = new Map<number, number | null>()

	/**
	 * The population a settlement's children divide.
	 */
	const baseOf = (id: number): number | null => {
		const known = baseMemo.get(id)

		if (known !== undefined) return known

		baseMemo.set(id, null)

		const place = byID.get(id)
		let base: number | null = null

		if (place && SETTLEMENT_PLACETYPES.has(place.placetype)) {
			const measured = measuredOf(place)

			if (!SUB_LOCALITY_PLACETYPES.has(place.placetype)) {
				base = measured
			} else {
				const above = baseOf(place.parentID)

				base = measured !== null && (above === null || measured < above) ? measured : estimateOf(place)
			}
		}

		baseMemo.set(id, base)

		return base
	}

	/**
	 * The estimate a sub-locality gets from its parent, whether or not it has a measured population.
	 */
	const estimateOf = (place: HierarchyPlace): number | null => {
		const known = estimateMemo.get(place.id)

		if (known !== undefined) return known

		estimateMemo.set(place.id, null)

		const base = baseOf(place.parentID)
		const estimate = base === null ? null : base / (familySize(place) + 1)

		estimateMemo.set(place.id, estimate)

		return estimate
	}

	const stats: SubLocalityEstimateStats = {
		subLocalities: 0,
		measured: 0,
		measuredAsWhole: 0,
		estimated: 0,
		unestimable: 0,
	}

	const residuals: number[] = []
	const pending: Array<{ place: HierarchyPlace; estimate: number }> = []

	for (const place of byID.values()) {
		if (!SUB_LOCALITY_PLACETYPES.has(place.placetype)) continue

		stats.subLocalities++

		const measured = measuredOf(place)
		const estimate = estimateOf(place)

		if (measured !== null) {
			stats.measured++

			const above = baseOf(place.parentID)

			if (above !== null && measured >= above) {
				stats.measuredAsWhole++
			} else if (estimate !== null && estimate > 0) {
				residuals.push(Math.log10(measured / estimate))
			}

			continue
		}

		// Under one person is a share of a settlement too small to rank.
		if (estimate === null || estimate < 1) {
			stats.unestimable++

			continue
		}

		pending.push({ place, estimate })
	}

	if (!residuals.length) {
		stats.unestimable += pending.length

		return { estimates: [], calibration: null, stats }
	}

	const p10 = percentile(residuals, LOWER_DECILE)!
	const rankFactor = 10 ** Math.min(p10, 0)

	const calibration: SubLocalityCalibration = {
		compared: residuals.length,
		p10,
		p50: percentile(residuals, 50)!,
		p90: percentile(residuals, 100 - LOWER_DECILE)!,
		rankFactor,
	}

	const estimates: SubLocalityEstimate[] = []

	for (const { place, estimate } of pending) {
		stats.estimated++

		estimates.push({
			id: place.id,
			population: estimate,
			rankPopulation: estimate * rankFactor,
			parentID: place.parentID,
			siblings: familySize(place),
		})
	}

	return { estimates, calibration, stats }
}

/**
 * Reads the current settlements and sub-localities of an admin database (`spr` and `place_population`)
 * and estimates each unmeasured sub-locality's population with {@link estimateFromHierarchy}.
 */
export function estimateSubLocalityPopulations<DB>(db: DatabaseClient<DB>): SubLocalityEstimates {
	const placetypes = [...SETTLEMENT_PLACETYPES]

	const rows = allRows<{ id: number; placetype: string; parent_id: number; population: number | null }>(
		db.prepare(
			`SELECT s.id AS id, s.placetype AS placetype, s.parent_id AS parent_id, p.population AS population
			 FROM spr s LEFT JOIN place_population p ON p.id = s.id
			 WHERE s.is_current != 0 AND s.is_deprecated = 0 AND s.placetype IN (${placetypes.map(() => "?").join(", ")})`
		),
		...placetypes
	)

	const places = rows.map((row) => ({
		id: Number(row.id),
		placetype: String(row.placetype),
		parentID: Number(row.parent_id),
		population: typeof row.population === "number" ? row.population : null,
	}))

	// The gazetteer is a Collective Database whose Overture Divisions part is ODbL.
	// A division counted as a sibling, or in the calibration, would change a WOF
	// place's estimate, so the places outside that part are estimated without it,
	// and only the divisions' own estimates come from the whole set.
	// The calibration and counts returned are the part outside Overture's.
	const restPlaces = places.filter((place) => !isOverturePartID(place.id))
	const rest = estimateFromHierarchy(restPlaces)

	if (restPlaces.length === places.length) return rest

	const overture = estimateFromHierarchy(places).estimates.filter((estimate) => isOverturePartID(estimate.id))

	return { ...rest, estimates: [...rest.estimates, ...overture] }
}
