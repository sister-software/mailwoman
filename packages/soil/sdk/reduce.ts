/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The reduction: the containment index, read once, into one per-cell distribution both consumers share.
 *
 *   A DISTRIBUTION, NEVER A WINNER, AND THAT IS FORCED BY MEASUREMENT. 84.0% of the 339,191 national map
 *   units hold two or more components; in 16.8% the largest component covers under half the map unit; and
 *   85.4% of `IA153`'s delineations are smaller than one resolution-9 cell. No affordable cell size removes
 *   the mixture — it is a property of the survey, whose own `mukind` says so: 128,499 map units (38.0%) are
 *   complexes, associations or undifferentiated groups, which is NRCS stating that the soils are
 *   intermingled and cannot be separated at the mapping scale. A winner class would satisfy the result-level
 *   consumer and starve the signal consumer, which needs a magnitude to vary over.
 *
 *   THE WEIGHT IS A UNIFORM-AREA LATTICE OVER THE CELL, AND THE GRAIN IS CHOSEN AGAINST THE AUTHORITY'S OWN.
 *   A cell's children at {@link WEIGHT_LATTICE_DEPTH} levels finer have equal area by construction, so
 *   counting which delineation covers each child centre estimates covered area without a polygon clip. At
 *   depth 2 that is 49 children — 2.04% per child, which is the finest share NRCS's own
 *   `muaggatt.niccdcdpct` ever reports (observed minimum: 2%). Resolving finer than the authority publishes
 *   would be precision this layer cannot source.
 *
 *   A WHOLE CELL SKIPS THE LATTICE ENTIRELY, and that is exact rather than an optimization: a cell lying
 *   wholly inside one delineation is covered by that delineation and by nothing else, so its distribution is
 *   that map unit's component split and its `mapped_share` is 1.
 *
 *   `mapped_share` EXISTS BECAUSE A SURVEY-AREA EDGE CELL IS PARTLY OUTSIDE EVERY DELINEATION. Without it,
 *   the unmapped remainder would silently deflate every class share — an absence represented as a small
 *   number, which is the one thing this schema exists to prevent. The five shares are normalized over the
 *   mapped part, so they sum to 1 exactly, and `mapped_share` says how much of the cell that was.
 *
 *   CLASS 8 IS A CLASS SHARE, NOT AN ABSENCE. It is a determination — the survey looked and rated the land
 *   as precluding commercial plant production, and 67,547 national components carry it. Folding it in with
 *   `NOTCOM`, a water body and an unrated series would produce a well-formed wrong answer, and separating
 *   the four absences from the one positive negative is the whole reason this table has five columns rather
 *   than one.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { pointInEncodedRings, type H3Cell } from "@mailwoman/spatial"
import { cellToChildren, cellToLatLng } from "h3-js"

import type { SoilCapabilityCellTable, SoilComponentTable, SoilMapUnitTable } from "../schema.ts"
import { SOIL_SHARE_WEIGHTING } from "../vocabulary.ts"

/**
 * How many resolution levels finer than the index the weighting lattice runs.
 *
 * Two, giving 49 children per cell and a 2.04% share granularity. That is deliberately matched to the finest share the
 * authority itself publishes — `muaggatt.niccdcdpct`'s observed minimum is 2% — because a lattice finer than the
 * source's own reporting grain buys precision this layer cannot source, at 7× the cost per level.
 */
export const WEIGHT_LATTICE_DEPTH = 2

/**
 * Class shares below this are folded into `other_share` rather than stored.
 *
 * One percent, which sits BELOW the lattice's own 2.04% granularity, so nothing a single child cell produces is
 * truncated — what lands here is the long tail that component percentages create inside a child (a 1%-weight component
 * inside one child cell contributes 0.02%). Truncating a long tail is legitimate; doing it silently is not, which is
 * why the remainder is stored explicitly and the shares still sum to 1.
 */
export const CLASS_SHARE_FLOOR = 0.01

/**
 * One delineation reaching a cell, as the reduction needs it.
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
 * What a map unit contributes per unit of area — computed once per map unit and reused for every cell it reaches.
 */
export interface MapUnitProfile {
	/**
	 * Class code → share of the map unit, summing to 1 across classes and the three mapped-absence buckets.
	 */
	classShares: ReadonlyMap<string, number>
	unrated: number
	notRateable: number
	noData: number
}

/**
 * Turn one map unit and its components into the per-unit-area profile the reduction folds in.
 *
 * A `no_mapping` map unit contributes wholly to `nodata` and NEVER to a class: it is a polygon the authority drew with
 * no soil mapping behind it, and reading it as a low class would be the reassuring wrong number §3.2 of the survey is
 * about.
 *
 * The split across components is by `comppct_r`, the component's representative percentage of its map unit, normalized
 * by the total actually present rather than assumed to be 100 — measured on `IA153` all 152 map units sum to exactly
 * 100, and a national build must not depend on that holding everywhere.
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

	// A map unit whose components carry no weight at all publishes no readable proportion, so nothing can be apportioned
	// from it. It is marked `no_mapping` upstream for exactly this reason; reaching here with a zero total means the
	// upstream check and this one disagree, and answering with an empty distribution would silently drop the delineation's
	// area out of every share.
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

		// A NULL rating means the survey did not rate this component, and WHY it did not is what separates the two buckets.
		// A miscellaneous area is a non-soil area — rock outcrop, water — that the capability rating does not apply to; a
		// named soil with no rating is one the survey chose not to rate. Read as one number they would both say "not
		// arable", which neither of them says.
		if (component.compkind === "Miscellaneous area") {
			notRateable += weight
		} else {
			unrated += weight
		}
	}

	return { classShares, unrated, notRateable, noData: 0 }
}

/**
 * What one cell's reduction produced, plus the diagnostics the receipt reports.
 */
export interface ReducedCell {
	row: SoilCapabilityCellTable
	/**
	 * True when the top class covers less than half the cell — the §4.7 number, counted here so it comes off the artifact
	 * rather than out of a separate harness.
	 */
	topClassUnderHalf: boolean
	/**
	 * True when the lattice was used rather than the whole-cell fast path.
	 */
	sampled: boolean
}

/**
 * Reduce one cell.
 *
 * @throws {Error} When a candidate names a map unit the profile map does not hold. A missing profile means the
 *   attribute join is short, and answering with the remaining candidates would report a well-formed distribution over
 *   part of the cell.
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
		// Exactly one delineation, and it covers the cell entirely. Nothing else can reach it, so the lattice would return
		// the same answer at 49 times the cost.
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
			// Every child centre fell outside every delineation reaching the cell. The cell IS touched — the index says so —
			// but no lattice point landed inside, which happens when a sliver clips a corner. Reporting shares over nothing
			// would divide by zero; reporting a mapped share of zero is the truthful answer, and the row is dropped by the
			// caller rather than stored as an all-zero distribution.
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
 * The delineation covering a point, or `undefined` where none does.
 *
 * The bounding box is the prefilter the geometry table stores precisely so the ray cast runs on the few delineations
 * that could contain the point rather than on every delineation reaching the cell.
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
 * Fold the per-map-unit weights through their profiles into the stored row.
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

	// The floor truncates the long tail component percentages create inside a lattice child. The remainder is stored
	// rather than dropped, so the five shares sum to 1 and a reader can see how much was folded away.
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
			class_shares: JSON.stringify(Object.fromEntries(kept.map(([code, share]) => [code, round(share)]))),
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
 * A cell no lattice point landed inside. `mapped_share` zero says exactly that, and the caller drops it rather than
 * storing an all-zero distribution that would read as a surveyed cell holding nothing.
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
 * Six decimals — a millionth of a cell, far below the lattice's own 2% granularity, and enough that the stored shares
 * still sum to 1 within a rounding error a reader can see is rounding.
 */
const SHARE_DECIMALS = 6

function round(value: number): number {
	return Number(value.toFixed(SHARE_DECIMALS))
}

/**
 * The sum of a stored row's five shares. Exported because the invariant it checks — that they sum to 1 — is what makes
 * `other_share` required rather than decorative, and a test that could not state the sum could not pin it.
 */
export function shareTotal(row: SoilCapabilityCellTable): number {
	const classes = parseJSONStrict<Record<string, number>>(row.class_shares)

	let total = row.unrated_share + row.notrateable_share + row.nodata_share + row.other_share

	for (const share of Object.values(classes)) {
		total += share
	}

	return total
}
