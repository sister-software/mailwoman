/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The route scale of the map: one GeoJSON line for each route segment a selection of buildings uses.
 *   A segment's path and its basis are supplied beside the scenario, because `@mailwoman/route-scenarios`
 *   prices segments without geometry.
 *
 *   A segment is verified only when its basis is a source record that the dossier admitted. A segment whose
 *   basis is an operator assumption is proposed construction. A segment that more than one selected building
 *   uses is shared. Each segment's amount is the construction cost that `constructionCost` charges for it
 *   once in the selection.
 */

import type { Dossier, EntityID } from "@mailwoman/dossier"
import {
	constructionCost,
	type InputBasis,
	InputBasisKind,
	type MinorUnits,
	prepareScenario,
	type Scenario,
} from "@mailwoman/route-scenarios"
import type { Coordinates2D, GeoFeature, GeoFeatureCollection, LineStringLiteral } from "@mailwoman/spatial"

import { checkLineCoordinates, MapInputError } from "#inputs"

/**
 * Whether a route segment exists or is proposed, as wire values.
 */
export const SegmentStatus = {
	Verified: "verified",
	Proposed: "proposed",
} as const

export type SegmentStatus = (typeof SegmentStatus)[keyof typeof SegmentStatus]

/**
 * The path of one route segment, with the record that establishes the segment.
 */
export interface SegmentPath {
	/**
	 * The segment's identifier in the scenario.
	 */
	segment: string
	/**
	 * The segment's path as [longitude, latitude] positions in WGS 84 decimal degrees.
	 */
	coordinates: readonly Coordinates2D[]
	/**
	 * A source record that the dossier admitted verifies an existing segment.
	 *
	 * An operator assumption makes the segment proposed construction.
	 */
	basis: InputBasis
	/**
	 * `true` for a path invented for an example.
	 */
	synthetic: boolean
}

export interface RouteSegmentProperties {
	segment: string
	description: string
	status: SegmentStatus
	basis: InputBasis
	/**
	 * `true` when more than one selected building uses the segment.
	 */
	shared: boolean
	/**
	 * The selected buildings whose route includes the segment, in selection order.
	 */
	usedBy: readonly EntityID[]
	/**
	 * `true` when the path is synthetic.
	 */
	synthetic: boolean
	/**
	 * The segment's construction cost in the selection, charged once.
	 *
	 * `synthetic` is `true` when the scenario's inputs are synthetic.
	 */
	economics: { amount: MinorUnits; currency: string; synthetic: boolean }
}

export type RouteFeature = GeoFeature<LineStringLiteral, RouteSegmentProperties>

export type RouteCollection = GeoFeatureCollection<LineStringLiteral, RouteSegmentProperties>

/**
 * Throws {@link MapInputError} unless a source-record basis cites a record that the dossier admitted.
 */
function checkAdmittedBasis(dossier: Dossier, basis: InputBasis, path: string): void {
	if (basis.kind !== InputBasisKind.SourceRecord || dossier.admitted.includes(basis.source)) return

	const excluded = dossier.excluded.find((record) => record.id === basis.source)

	const reason = excluded
		? `became available on ${excluded.availableAt}, after the as-of date ${dossier.asOf}`
		: dossier.undated.includes(basis.source)
			? "has no availability date, so the dossier cannot admit it"
			: "is not a record in the dossier"

	throw new MapInputError(path, `the source record ${basis.source} ${reason}`)
}

/**
 * Returns the paths by segment identifier after checking each one against the scenario and the dossier.
 */
function pathIndex(
	dossier: Dossier,
	scenario: Scenario,
	paths: readonly SegmentPath[]
): ReadonlyMap<string, SegmentPath> {
	const defined = new Set(scenario.segments.map((segment) => segment.id))
	const index = new Map<string, SegmentPath>()

	for (const path of paths) {
		const at = `paths[${path.segment}]`

		if (!defined.has(path.segment)) {
			throw new MapInputError(at, `scenario ${scenario.id} defines no segment ${path.segment}`)
		}

		if (index.has(path.segment)) throw new MapInputError(at, `the segment ${path.segment} has two paths`)

		checkLineCoordinates(path.coordinates, at)
		checkAdmittedBasis(dossier, path.basis, `${at}.basis`)
		index.set(path.segment, path)
	}

	return index
}

/**
 * The route scale of the map for `selection`, which defaults to the scenario's selected buildings.
 *
 * The selection is priced through `prepareScenario` and `constructionCost` in
 * `@mailwoman/route-scenarios`, so a selected building with an unresolved unit total throws there.
 */
export function routeFeatures(
	dossier: Dossier,
	scenario: Scenario,
	paths: readonly SegmentPath[],
	selection: readonly EntityID[] = scenario.selected
): RouteCollection {
	const index = pathIndex(dossier, scenario, paths)
	const cost = constructionCost(prepareScenario(dossier, { ...scenario, selected: selection }))
	const synthetic = scenario.origin === "synthetic"

	return {
		type: "FeatureCollection",
		features: cost.segments.map((entry): RouteFeature => {
			const path = index.get(entry.segment.id)

			if (!path) {
				throw new MapInputError(
					`paths[${entry.segment.id}]`,
					`segment ${entry.segment.id} has no path, and the selection uses it`
				)
			}

			return {
				type: "Feature",
				geometry: {
					type: "LineString",
					coordinates: path.coordinates.map(([longitude, latitude]) => [longitude, latitude]),
				},
				properties: {
					segment: entry.segment.id,
					description: entry.segment.description,
					status: path.basis.kind === InputBasisKind.SourceRecord ? SegmentStatus.Verified : SegmentStatus.Proposed,
					basis: path.basis,
					shared: entry.usedBy.length > 1,
					usedBy: entry.usedBy,
					synthetic: path.synthetic,
					economics: { amount: entry.amount, currency: scenario.currency, synthetic },
				},
			}
		}),
	}
}
