/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Add local-authority zoning designations as observations after geocoding.
 *   The route never changes answer selection and reports only published designations.
 *   Each observation preserves the local code, jurisdiction, plan, coverage, and limitations.
 *   No designation is not evidence that land is unrestricted.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	ZoningLookup,
	ZoningReadingKind,
	type ZoningContainmentPath,
	type ZoningDesignation,
	type ZoningLayerIdentity,
	type ZoningReading,
} from "@mailwoman/zoning"
import type { PathBuilderLike } from "path-ts"

import {
	createDesignationRoute,
	describeCoverage,
	describeLayerProvenance,
	observationCoverageRecord,
	observationLayerRecord,
	type ObservationCoverageRecord,
	type ObservationLayerRecord,
} from "#observations/layer-record"

/**
 * Zoning designation and provenance recorded beside an answer.
 */
export interface ZoningDesignationObservation {
	/**
	 * Always `designated`.
	 *
	 * `unknown` produces no observation — see this file's header.
	 */
	reading: ZoningReadingKind
	/**
	 * Every polygon containing the point.
	 *
	 * Usually one.
	 * Several where a Local Area Plan overlays a Development Plan over the same ground,
	 * which the publisher issues as two rows.
	 */
	designations: ZoningDesignation[]
	containment: ZoningContainmentPath
	/**
	 * The coverage side of the claim.
	 *
	 * Its basis is `source_present`, which supports presence and nothing else.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell probed.
	 */
	indexCellIndex: string
	/**
	 * What the product does not state, in the publisher's own words.
	 */
	limits: ReadonlyArray<string>
	/**
	 * Why this layer's coverage licenses no claim that a location is unrestricted.
	 */
	coverageLimit: string
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Named reasons a coordinate produced no observation.
 */
export const ZONING_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * No adopted plan in this product assigns a zoning designation here.
	 *
	 * Not an absence claim: the location may be outside any plan area, inside one on land
	 * the plan does not zone, in a jurisdiction that has never zoned, or in one whose
	 * records are not published, and the product cannot tell those apart.
	 */
	"no_designation_here",
] as const

export type ZoningRefusal = (typeof ZONING_REFUSALS)[number]

/**
 * Observation or named refusal for one coordinate.
 */
export type ZoningDecision =
	| { fired: true; observation: ZoningDesignationObservation }
	| { fired: false; refusal: ZoningRefusal }

export interface ZoningDesignationRoute extends Disposable {
	identity: ZoningLayerIdentity
	/**
	 * Read the layer for one coordinate; missing coordinates return a named refusal.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => ZoningDecision
}

export interface ZoningDesignationRouteOptions {
	/**
	 * The sealed layer to read.
	 *
	 * Required: there is no default layer, and a route that guessed one would report
	 * a designation from an authority nobody asked about.
	 */
	databasePath: PathBuilderLike
}

/**
 * Build the route against one sealed layer; the reader validates its manifest and coverage.
 */
export function createZoningDesignationRoute(options: ZoningDesignationRouteOptions): ZoningDesignationRoute {
	const lookup = new ZoningLookup({ databasePath: options.databasePath })

	return createDesignationRoute(lookup, {
		read: (latitude, longitude) => lookup.lookup(latitude, longitude),
		refusalFor: (reading) => (reading.kind !== ZoningReadingKind.Designated ? "no_designation_here" : undefined),
		toObservation: (reading, latitude, longitude) =>
			toObservation(reading, lookup.identity, latitude, longitude, options.databasePath.toString()),
	})
}

/**
 * Build the observation for a reading the refusal check let through.
 */
function toObservation(
	reading: ZoningReading,
	identity: ZoningLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): ZoningDesignationObservation {
	const { manifest } = identity

	return {
		reading: reading.kind,
		designations: reading.designations,
		containment: reading.containment,
		...observationCoverageRecord(reading.coverage),
		indexCellIndex: reading.indexCellIndex,
		limits: reading.limits,
		coverageLimit: reading.coverageLimit,
		layer: observationLayerRecord(manifest),
		databasePath,
		coordinate: { latitude, longitude },
	}
}

/**
 * What the adopted plan assigns, in one wording — the authority's own code verbatim,
 * the publisher's generic type beside it, and the named plan — shared by the
 * one-line description and the marker message.
 */
export function zoningAssignmentClause(observation: ZoningDesignationObservation): string {
	const first = observation.designations[0]

	return first
		? `${first.jurisdiction.name} zones the location ${stringifyJSON(first.localCode)}` +
				(first.crosswalk ? ` (${first.crosswalk.scheme} ${first.crosswalk.code})` : "") +
				` under ${first.plan.name}` +
				(observation.designations.length > 1 ? ` (and ${observation.designations.length - 1} more plan(s) here)` : "")
		: "an adopted plan zones the location"
}

/**
 * One line a reader can check the claim from, with the authority, the plan and the vintage on it.
 */
export function describeZoningDesignation(observation: ZoningDesignationObservation): string {
	return (
		`${zoningAssignmentClause(observation)} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} ` +
		`(${observation.containment}); ${describeCoverage(observation.coverage)}; ${describeLayerProvenance(observation.layer, { tier: true })}`
	)
}
