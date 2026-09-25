/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reduces the delineations that reach a cell into that cell's capability-class distribution.
 *
 *   The result is a distribution because most map units mix several soil components that the survey
 *   cannot separate at its mapping scale. Shares are normalized over the mapped part of the cell, and
 *   `mapped_share` records how large that part is. Capability class 8 is a rated class, so it is stored as a
 *   class share. The unrated share, the no-data share and the not-rateable share each have their own column.
 */

import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { pointInEncodedRings, type H3Cell } from "@mailwoman/spatial"
import { cellToChildren, cellToLatLng } from "h3-js"

import type { SoilCapabilityCellTable, SoilComponentTable, SoilMapUnitTable } from "#schema"
import { SOIL_SHARE_WEIGHTING } from "#vocabulary"

/**
 * The number of H3 levels below the index resolution at which the weighting lattice samples.
 *
 * Children at a finer resolution have equal area, so counting which delineation
 * covers each child centre estimates the covered area.
 * A depth of 2 gives 49 children, or about 2% per child.
 *
 * NRCS publishes component shares no finer than 2%, and each extra level costs seven times as much.
 */
export const WEIGHT_LATTICE_DEPTH = 2

/**
 * The class share below which a class is added to `other_share` instead of stored.
 *
 * The floor is below the lattice's 2% step, so it only removes the small shares
 * that minor components contribute.
 * Adding them to `other_share` keeps the shares summing to 1.
 */
export const CLASS_SHARE_FLOOR = 0.01

/**
 * One delineation that reaches a cell.
 */
export interface CellCandidate {
	areaID: string
	mukey: string
	containment: string
	minLat: number
	minLon: number
	maxLat: number
	maxLon: number
	rings: Uint8Array
}

/**
 * The shares that a map unit contributes per unit of area.
 */
export interface MapUnitProfile {
	/**
	 * Each class code's share of the map unit.
	 * These shares and the three absence shares sum to 1.
	 */
	classShares: ReadonlyMap<string, number>
	unrated: number
	notRateable: number
	noData: number
}

/**
 * Builds the profile of one map unit from its components.
 *
 * A `no_mapping` map unit contributes only to `noData`, because it has no soil mapping.
 *
 * Components are weighted by `comppct_r`, the component's representative percentage of its map unit.
 * The weights are divided by their actual total, because the percentages may not sum to 100.
 */
export function mapUnitProfile(
	mapUnit: Pick<SoilMapUnitTable, "no_mapping">,
	components: ReadonlyArray<Pick<SoilComponentTable, "comppct_r" | "compkind" | "nirrcapcl">>
): MapUnitProfile {
	if (mapUnit.no_mapping) {
		return { classShares: new Map(), unrated: 0, notRateable: 0, noData: 1 }
	}

	let total = 0

	for (const component of components) {
		total += component.comppct_r
	}

	// Components with zero total weight give no proportions, so the map unit counts as no data.
	// An empty distribution would drop the delineation's area from every share.
	if (total <= 0) {
		return { classShares: new Map(), unrated: 0, notRateable: 0, noData: 1 }
	}

	const classShares = new Map<string, number>()

	let unrated = 0
	let notRateable = 0

	for (const component of components) {
		const weight = component.comppct_r / total

		if (weight <= 0) continue

		if (component.nirrcapcl) {
			classShares.set(component.nirrcapcl, (classShares.get(component.nirrcapcl) ?? 0) + weight)

			continue
		}

		// A miscellaneous area, such as rock outcrop or water, cannot take a capability rating.
		// Any other component with a NULL rating is a soil that the survey did not rate.
		if (component.compkind === "Miscellaneous area") {
			notRateable += weight
		} else {
			unrated += weight
		}
	}

	return { classShares, unrated, notRateable, noData: 0 }
}

/**
 * The stored row for one cell, plus diagnostics for the build report.
 */
export interface ReducedCell {
	row: SoilCapabilityCellTable
	/**
	 * Whether the top class covers less than half the cell.
	 */
	topClassUnderHalf: boolean
	/**
	 * Whether the lattice was used instead of the whole-cell fast path.
	 */
	sampled: boolean
}

/**
 * Reduces one cell.
 *
 * @throws {Error} When a candidate's map unit has no profile.
 * A missing profile means the attribute join is incomplete, and the remaining
 * candidates would describe only part of the cell.
 */
export function reduceCell(
	cell: H3Cell,
	resolution: number,
	candidates: ReadonlyArray<CellCandidate>,
	profiles: ReadonlyMap<string, MapUnitProfile>,
	h3Cell: number
): ReducedCell {
	const weights = new Map<string, number>()
	let sampled = false
	let mappedShare = 1

	const whole = candidates.length === 1 ? candidates.find((candidate) => candidate.containment === "whole") : undefined

	if (whole) {
		// A single delineation covers the whole cell, so the lattice would give the same answer.
		weights.set(whole.mukey, 1)
	} else {
		sampled = true

		const children = cellToChildren(cell, resolution + WEIGHT_LATTICE_DEPTH)
		let covered = 0

		for (const child of children) {
			const [latitude, longitude] = cellToLatLng(child)
			const owner = candidateAt(candidates, latitude, longitude)

			if (!owner) continue

			covered++
			weights.set(owner.mukey, (weights.get(owner.mukey) ?? 0) + 1)
		}

		if (!covered) {
			// No child centre fell inside a delineation, which happens when a sliver clips a corner.
			// The row has a mapped share of zero, and the caller drops it.
			return {
				row: emptyRow(h3Cell, candidates.length),
				topClassUnderHalf: false,
				sampled,
			}
		}

		mappedShare = covered / children.length

		for (const [mukey, count] of weights) {
			weights.set(mukey, count / covered)
		}
	}

	return assembleRow(h3Cell, weights, profiles, mappedShare, candidates.length, sampled)
}

/**
 * Returns the delineation that covers a point, or `undefined` when none does.
 *
 * A bounding-box test runs first so that the ray cast runs only on delineations
 * that could contain the point.
 */
function candidateAt(
	candidates: ReadonlyArray<CellCandidate>,
	latitude: number,
	longitude: number
): CellCandidate | undefined {
	for (const candidate of candidates) {
		if (
			longitude < candidate.minLon ||
			longitude > candidate.maxLon ||
			latitude < candidate.minLat ||
			latitude > candidate.maxLat
		) {
			continue
		}

		if (pointInEncodedRings(candidate.rings, longitude, latitude)) return candidate
	}

	return undefined
}

/**
 * Combines the per-map-unit weights with their profiles into the stored row.
 */
function assembleRow(
	h3Cell: number,
	weights: ReadonlyMap<string, number>,
	profiles: ReadonlyMap<string, MapUnitProfile>,
	mappedShare: number,
	delineations: number,
	sampled: boolean
): ReducedCell {
	const classShares = new Map<string, number>()

	let unrated = 0
	let notRateable = 0
	let noData = 0

	for (const [mukey, weight] of weights) {
		const profile = profiles.get(mukey)

		if (!profile) {
			throw new Error(
				`soil reduce: cell ${h3Cell} names map unit ${mukey}, which the attribute join does not hold — a missing profile means the join is short, and reducing the remaining candidates would report a well-formed distribution over part of the cell`
			)
		}

		for (const [code, share] of profile.classShares) {
			classShares.set(code, (classShares.get(code) ?? 0) + share * weight)
		}

		unrated += profile.unrated * weight
		notRateable += profile.notRateable * weight
		noData += profile.noData * weight
	}

	// Classes below the floor go into `other_share` so that the shares still sum to 1.
	let other = 0
	const kept: Array<[string, number]> = []

	for (const [code, share] of classShares) {
		if (share < CLASS_SHARE_FLOOR) {
			other += share
		} else {
			kept.push([code, share])
		}
	}

	kept.sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))

	const top = kept[0]

	return {
		row: {
			h3_cell: h3Cell,
			class_shares: stringifyJSON(Object.fromEntries(kept.map(([code, share]) => [code, round(share)]))),
			unrated_share: round(unrated),
			notrateable_share: round(notRateable),
			nodata_share: round(noData),
			other_share: round(other),
			mapped_share: round(mappedShare),
			top_class: top ? top[0] : null,
			top_class_share: top ? round(top[1]) : null,
			weighting: SOIL_SHARE_WEIGHTING,
			delineations,
		},
		topClassUnderHalf: !top || top[1] < 0.5,
		sampled,
	}
}

/**
 * Returns the row for a cell that no lattice point landed in.
 *
 * The caller drops a row with a zero `mapped_share`, because storing it would
 * look like a surveyed cell with no soil.
 */
function emptyRow(h3Cell: number, delineations: number): SoilCapabilityCellTable {
	return {
		h3_cell: h3Cell,
		class_shares: "{}",
		unrated_share: 0,
		notrateable_share: 0,
		nodata_share: 0,
		other_share: 0,
		mapped_share: 0,
		top_class: null,
		top_class_share: null,
		weighting: SOIL_SHARE_WEIGHTING,
		delineations,
	}
}

/**
 * The number of decimals kept in a stored share, far finer than the lattice's 2% step.
 */
const SHARE_DECIMALS = 6

function round(value: number): number {
	return Number(value.toFixed(SHARE_DECIMALS))
}

/**
 * Returns the sum of a stored row's class shares and four other shares.
 *
 * Tests use it to check that the shares sum to 1.
 */
export function shareTotal(row: SoilCapabilityCellTable): number {
	const classes = parseJSONStrict<Record<string, number>>(row.class_shares)

	let total = row.unrated_share + row.notrateable_share + row.nodata_share + row.other_share

	for (const share of Object.values(classes)) {
		total += share
	}

	return total
}
