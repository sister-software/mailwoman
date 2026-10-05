/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The district scale of the map: buildings clustered by an extent kind the caller chooses, such as
 *   `census-tract`. An extent's kind is its text before the first colon, so `census-tract:36047050401` has
 *   the kind `census-tract`.
 *
 *   A building joins a cluster when exactly one admitted membership of the kind places it. A building with
 *   none goes into one unplaced feature, and a building with two or more goes into one ambiguous feature,
 *   so no building is counted twice and every building is counted once. A cluster reports what it cannot
 *   sum: the sum of its resolved unit totals, the count of its buildings whose total is unresolved, and the
 *   count of its buildings in each state. The district features therefore add up to the building scale's
 *   building count, resolved units, unresolved totals and states.
 */

import type { Dossier, EntityID, UnitStage } from "@mailwoman/dossier"
import type { Coordinates2D, GeoFeature, GeoFeatureCollection, MultiPointLiteral } from "@mailwoman/spatial"

import { BuildingState, buildingProperties, type BuildingProperties } from "#buildings"
import { MapInputError } from "#inputs"

/**
 * How a district feature's buildings are placed, as wire values.
 */
export const DistrictPlacement = {
	Clustered: "clustered",
	Unplaced: "unplaced",
	Ambiguous: "ambiguous",
} as const

export type DistrictPlacement = (typeof DistrictPlacement)[keyof typeof DistrictPlacement]

export interface DistrictProperties {
	extentKind: string
	/**
	 * The extent that places every building of a cluster, or `null` for the unplaced and ambiguous features.
	 */
	extent: string | null
	placement: DistrictPlacement
	buildings: readonly EntityID[]
	units: {
		stage: UnitStage
		/**
		 * The sum of the resolved unit totals.
		 */
		resolved: number
		/**
		 * The number of buildings whose unit total is unresolved.
		 * The sum leaves their units out.
		 */
		unresolvedBuildings: number
	}
	states: Record<BuildingState, number>
}

export type DistrictFeature = GeoFeature<MultiPointLiteral | null, DistrictProperties>

export type DistrictCollection = GeoFeatureCollection<MultiPointLiteral | null, DistrictProperties>

export interface DistrictOptions {
	unitStage: UnitStage
	/**
	 * The kind of extent to cluster by: the text before the first colon of an extent, such as `census-tract`.
	 */
	extentKind: string
}

interface Member {
	properties: BuildingProperties
	point: Coordinates2D | null
}

function districtFeature(
	members: readonly Member[],
	placement: DistrictPlacement,
	extent: string | null,
	options: DistrictOptions
): DistrictFeature {
	const states = Object.fromEntries(Object.values(BuildingState).map((state) => [state, 0])) as Record<
		BuildingState,
		number
	>

	let resolved = 0
	let unresolvedBuildings = 0

	for (const { properties } of members) {
		states[properties.state] += 1

		if (properties.units.total === "unresolved") {
			unresolvedBuildings += 1
		} else {
			resolved += properties.units.total
		}
	}

	const points = members.flatMap((member) => (member.point ? [member.point] : []))

	return {
		type: "Feature",
		geometry: points.length ? { type: "MultiPoint", coordinates: points } : null,
		properties: {
			extentKind: options.extentKind,
			extent,
			placement,
			buildings: members.map((member) => member.properties.building),
			units: { stage: options.unitStage, resolved, unresolvedBuildings },
			states,
		},
	}
}

/**
 * The district scale of the map: one feature per extent of the chosen kind,
 * in the order the dossier's buildings first name them, then the unplaced
 * and the ambiguous feature when either holds a building.
 */
export function districtFeatures(dossier: Dossier, options: DistrictOptions): DistrictCollection {
	const kind = options.extentKind

	if (!kind.trim() || kind.includes(":")) {
		throw new MapInputError(
			"extentKind",
			`"${kind}" is not an extent kind: give the text before an extent's first colon`
		)
	}

	const clusters = new Map<string, Member[]>()
	const unplaced: Member[] = []
	const ambiguous: Member[] = []

	for (const section of dossier.buildings) {
		const member: Member = {
			properties: buildingProperties(section, { unitStage: options.unitStage, asOf: dossier.asOf }),
			point: section.position.status === "resolved" ? [section.position.longitude, section.position.latitude] : null,
		}

		const extents = [
			...new Set(
				section.memberships.map((membership) => membership.extent).filter((extent) => extent.startsWith(`${kind}:`))
			),
		]

		if (extents.length === 1) {
			clusters.set(extents[0]!, [...(clusters.get(extents[0]!) ?? []), member])
		} else if (extents.length) {
			ambiguous.push(member)
		} else {
			unplaced.push(member)
		}
	}

	return {
		type: "FeatureCollection",
		features: [
			...[...clusters].map(([extent, members]) =>
				districtFeature(members, DistrictPlacement.Clustered, extent, options)
			),
			...(unplaced.length ? [districtFeature(unplaced, DistrictPlacement.Unplaced, null, options)] : []),
			...(ambiguous.length ? [districtFeature(ambiguous, DistrictPlacement.Ambiguous, null, options)] : []),
		],
	}
}
