/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Add a soil-survey observation after geocoding; it never changes answer selection.
 *   Record the capability distribution, top-class share, survey dates, coverage, and limits.
 *   A designated absence differs from an unrated cell and from an unmapped location.
 *   This describes the survey map, not site-specific land capability.
 */

import {
	SoilCapabilityLookup,
	SoilReadingKind,
	type SoilCapabilityDistribution,
	type SoilCapabilityReading,
	type SoilLayerIdentity,
	type SoilSurveyAreaRecord,
} from "@mailwoman/soil"
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
 * Soil-capability reading and provenance recorded beside an answer.
 */
export interface SoilCapabilityObservation {
	/**
	 * `designated` or `designated_no_rating`.
	 *
	 * Never `unknown`: that reading produces no observation.
	 */
	reading: SoilReadingKind
	/**
	 * The largest class share, and the share it rests on.
	 *
	 * Absent on a designated-no-rating reading, which is the survey saying it
	 * mapped this ground and rated nothing here.
	 */
	topClass?: string
	topClassShare?: number
	/**
	 * The authority's own definition of the top class, from the domain it ships inside the archive.
	 */
	topClassDefinition?: string
	/**
	 * The whole distribution, including the four absence shares and the truncated tail.
	 *
	 * What #1683's signal consumer reads directly from the artifact, carried here
	 * so the two consumers can be checked against each other.
	 */
	distribution: SoilCapabilityDistribution
	/**
	 * The survey area covering the location, with the refresh date and the far older field-survey date.
	 */
	surveyArea?: SoilSurveyAreaRecord
	/**
	 * The coverage side of the claim.
	 */
	coverage?: ObservationCoverageRecord
	indexCellIndex: string
	/**
	 * What the product excludes, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Named reasons a coordinate produced no observation.
 */
export const SOIL_DESIGNATION_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * The layer holds no coverage row for the location — outside every published survey area
	 * the artifact was built over, which is unknown and never a low-capability reading.
	 */
	"outside_surveyed_area",
] as const

export type SoilDesignationRefusal = (typeof SOIL_DESIGNATION_REFUSALS)[number]

/**
 * Observation or named refusal for one coordinate.
 */
export type SoilDesignationDecision =
	| { fired: true; observation: SoilCapabilityObservation }
	| { fired: false; refusal: SoilDesignationRefusal }

export interface SoilCapabilityRoute extends Disposable {
	identity: SoilLayerIdentity
	/**
	 * Read the layer for one coordinate; missing coordinates return a named refusal.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => SoilDesignationDecision
}

export interface SoilCapabilityRouteOptions {
	/**
	 * The sealed layer to read.
	 *
	 * Required: there is no default layer, and a route that guessed one would report
	 * a survey from a region nobody asked about.
	 */
	databasePath: PathBuilderLike
}

/**
 * Build the route against one sealed layer, validating its manifest, coverage, and vocabulary.
 */
export function createSoilCapabilityRoute(options: SoilCapabilityRouteOptions): SoilCapabilityRoute {
	const lookup = new SoilCapabilityLookup({ databasePath: options.databasePath })

	return createDesignationRoute(lookup, {
		read: (latitude, longitude) => lookup.lookup(latitude, longitude),
		refusalFor: (reading) =>
			reading.kind === SoilReadingKind.Unknown || !reading.distribution ? "outside_surveyed_area" : undefined,
		toObservation: (reading, latitude, longitude) =>
			toObservation(reading, lookup.identity, latitude, longitude, options.databasePath.toString()),
	})
}

/**
 * Build the observation for a reading the refusal check let through.
 */
function toObservation(
	reading: SoilCapabilityReading,
	identity: SoilLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): SoilCapabilityObservation {
	const { distribution } = reading

	if (!distribution) {
		throw new Error("soil route: a designated reading carries no distribution — refused before observation")
	}

	return {
		reading: reading.kind,
		...(distribution.topClass ? { topClass: distribution.topClass } : {}),
		...(distribution.topClassShare === undefined ? {} : { topClassShare: distribution.topClassShare }),
		...(reading.topClassDefinition ? { topClassDefinition: reading.topClassDefinition } : {}),
		distribution,
		...(reading.surveyArea ? { surveyArea: reading.surveyArea } : {}),
		...observationCoverageRecord(reading.coverage),
		indexCellIndex: reading.indexCellIndex,
		limits: reading.limits,
		layer: observationLayerRecord(identity.manifest),
		databasePath,
		coordinate: { latitude, longitude },
	}
}

/**
 * What the survey assigns, in one wording — the class never travels without the share
 * it rests on — shared by the one-line description and the marker message.
 */
export function soilCapabilityAssignmentClause(observation: SoilCapabilityObservation): string {
	return observation.topClass
		? `assigns land capability class ${observation.topClass} over ${((observation.topClassShare ?? 0) * 100).toFixed(1)}% of the cell`
		: "mapped this ground and rated no capability class here"
}

/**
 * One line a reader can check the claim from, with the authority, both dates,
 * and the share the class rests on.
 */
export function describeSoilCapability(observation: SoilCapabilityObservation): string {
	const vintage = observation.surveyArea
		? `survey area ${observation.surveyArea.areaSymbol}, refreshed ${observation.surveyArea.saverest}, field survey ${observation.surveyArea.surveySourceDate ?? "unstated"}`
		: "survey area unnamed"

	return (
		`The soil survey ${soilCapabilityAssignmentClause(observation)} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude}; ` +
		`${vintage}; ${describeCoverage(observation.coverage, { completeness: true })}; weighting ${observation.distribution.weighting}; ${describeLayerProvenance(observation.layer)}`
	)
}
