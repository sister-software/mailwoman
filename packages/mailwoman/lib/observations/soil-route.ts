/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Attaches a soil-survey land capability reading to a geocode answer as an observation. The route
 *   never changes answer selection.
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
 * A soil-survey land capability reading for a coordinate, with its coverage and provenance.
 *
 * The observation describes the survey map.
 * It makes no claim about a specific site.
 */
export interface SoilCapabilityObservation {
	/**
	 * Either `designated` or `designated_no_rating`.
	 * An `unknown` reading produces a refusal instead.
	 */
	reading: SoilReadingKind
	/**
	 * The capability class with the largest share of the cell, and that share.
	 *
	 * Both are absent on a `designated_no_rating` reading, where the survey
	 * mapped the ground but rated no class.
	 */
	topClass?: string
	topClassShare?: number
	/**
	 * The authority's definition of the top class, taken from the domain table in the archive.
	 */
	topClassDefinition?: string
	/**
	 * The full class distribution, including the four absence shares and the truncated tail.
	 */
	distribution: SoilCapabilityDistribution
	/**
	 * The survey area that covers the location, with its refresh date and field-survey date.
	 */
	surveyArea?: SoilSurveyAreaRecord
	/**
	 * The coverage record for the location.
	 */
	coverage?: ObservationCoverageRecord
	indexCellIndex: string
	/**
	 * The product's exclusions, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * The reasons a coordinate can produce no soil observation.
 */
export const SOIL_DESIGNATION_REFUSALS = [
	/**
	 * The geocode produced no coordinate.
	 */
	"no_coordinate",
	/**
	 * The layer has no coverage row for the location.
	 *
	 * The capability there is unknown, which must never be reported as low.
	 */
	"outside_surveyed_area",
] as const

/**
 * One {@link SOIL_DESIGNATION_REFUSALS} value.
 */
export type SoilDesignationRefusal = (typeof SOIL_DESIGNATION_REFUSALS)[number]

/**
 * The observation or refusal for one coordinate.
 */
export type SoilDesignationDecision =
	| { fired: true; observation: SoilCapabilityObservation }
	| { fired: false; refusal: SoilDesignationRefusal }

/**
 * Reads soil capability from one sealed layer.
 */
export interface SoilCapabilityRoute extends Disposable {
	identity: SoilLayerIdentity
	/**
	 * Reads the layer at one coordinate.
	 * A missing coordinate returns the `no_coordinate` refusal.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => SoilDesignationDecision
}

/**
 * Options for {@link createSoilCapabilityRoute}.
 */
export interface SoilCapabilityRouteOptions {
	/**
	 * The sealed layer to read.
	 * The route has no default layer.
	 */
	databasePath: PathBuilderLike
}

/**
 * Builds the route against one sealed layer.
 *
 * The reader validates the layer's manifest, coverage and vocabulary.
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
 * Builds the observation for a reading that passed the refusal check.
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
 * Returns the clause that states what the survey assigns.
 * The clause always pairs the class with its share.
 *
 * The one-line description and the marker message share this wording.
 */
export function soilCapabilityAssignmentClause(observation: SoilCapabilityObservation): string {
	return observation.topClass
		? `assigns land capability class ${observation.topClass} over ${((observation.topClassShare ?? 0) * 100).toFixed(1)}% of the cell`
		: "mapped this ground and rated no capability class here"
}

/**
 * Returns a one-line description of the observation, including both survey dates,
 * coverage and layer provenance.
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
