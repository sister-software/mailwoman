/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The soil-capability designation route, observation-only: after the resolver has produced a coordinate,
 *   the soil survey's own reading for that coordinate is recorded beside the answer — the capability class
 *   the survey assigns WITH the share of the cell it covers, the farmland classification as published
 *   including its condition, the survey area with BOTH its dates, and the coverage record stating that the
 *   authority mapped there.
 *
 *   THE ROUTE READS; IT NEVER ANSWERS. It takes a finished coordinate and returns a record. Nothing here is
 *   consulted while an answer is being chosen, no candidate is read, no result is added, removed or
 *   re-ordered, and no abstain is reached or avoided because of it.
 *
 *   PRESENCE IS THE SWITCH, AND IT IS A LAYER PATH. There is no boolean: a boolean would make the caller's
 *   factory construct the reader itself and put a sealed layer open on the default construction path.
 *
 *   THE SHARE IS NOT OPTIONAL, AND THAT IS THE WHOLE POINT OF THIS LAYER. NRCS's own map-unit aggregation
 *   ships its dominant-condition class beside the share that class covers, with an observed minimum of 2%.
 *   So a caller never receives a class without the share it rests on, and never receives a class at all when
 *   the cell holds none — a cell that is entirely unrated is complete and carries no capability reading,
 *   which is a different answer from unmapped ground and from land the survey rated as unsuitable.
 *
 *   THE OBSERVATION IS ABOUT THE MAP, NEVER ABOUT THE LAND. NRCS states that its data "do not eliminate the
 *   need for onsite sampling, testing, and detailed study of specific sites for intensive uses" and are
 *   "intended for planning purposes only". So the wording reports what the soil survey assigns to the map
 *   unit covering the location — a fact about the map — and never whether the land can be farmed. The
 *   product's own caveats ride on every observation, because a caller cannot see from a class code that the
 *   survey declines to speak about a specific site.
 *
 *   THE PROVENANCE CARRIES THE SURVEY VINTAGE, NOT ONLY THE REFRESH. A polygon republished in the 2025
 *   Annual Soils Refresh can rest on a field survey published in 1960 — that is `IA153`, measured — and the
 *   dataset's own time-period-of-content ends at the refresh, so a consumer reading THAT as survey currency
 *   reads it wrong by sixty-five years. Both dates reach the caller, apart, with the source title the older
 *   one came from.
 *
 *   A SECOND ROUTE RATHER THAN A WIDENED FIRST ONE. The flood layer's route carries a flood-shaped
 *   observation — a zone code, a containment path, the authority's zone definition — and this one carries a
 *   distribution, five shares and two dates. They share the marker CODE (`authority_designation`) and the
 *   `layer` mechanism family, which is what a reader branches on; folding them into one observation type
 *   would need a union every consumer then has to narrow, for no field either of them shares.
 */

import {
	SoilCapabilityLookup,
	SoilReadingKind,
	type SoilCapabilityDistribution,
	type SoilCapabilityReading,
	type SoilLayerIdentity,
	type SoilSurveyAreaRecord,
} from "@mailwoman/soil"

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
 * One soil-capability reading, recorded beside an answer.
 *
 * Everything a reader needs to check the claim is here: which authority, which product and vintage, the class
 * distribution with the four absence shares kept apart, the weighting that produced them, the survey area with both its
 * dates, and the coverage record that licenses the reading.
 */
export interface SoilCapabilityObservation {
	/**
	 * `designated` or `designated_no_rating`. Never `unknown`: that reading produces no observation.
	 */
	reading: SoilReadingKind
	/**
	 * The largest class share, and the share it rests on. Absent on a designated-no-rating reading, which is the survey
	 * saying it mapped this ground and rated nothing here.
	 */
	topClass?: string
	topClassShare?: number
	/**
	 * The authority's own definition of the top class, from the domain it ships inside the archive.
	 */
	topClassDefinition?: string
	/**
	 * The whole distribution, including the four absence shares and the truncated tail. What #1683's signal consumer
	 * reads directly from the artifact, carried here so the two consumers can be checked against each other.
	 */
	distribution: SoilCapabilityDistribution
	/**
	 * The survey area covering the location, with the refresh date AND the far older field-survey date.
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
 * Why a coordinate produced no observation. Every one of these is a SILENCE the route owes an account of — an unnamed
 * silence and a silence for the right reason read identically on a receipt.
 */
export const SOIL_DESIGNATION_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * The layer holds no coverage row for the location — outside every published survey area the artifact was built over,
	 * which is unknown and never a low-capability reading.
	 */
	"outside_surveyed_area",
] as const

export type SoilDesignationRefusal = (typeof SOIL_DESIGNATION_REFUSALS)[number]

/**
 * What the route decided about one coordinate: an observation, or a named silence.
 */
export type SoilDesignationDecision =
	| { fired: true; observation: SoilCapabilityObservation }
	| { fired: false; refusal: SoilDesignationRefusal }

export interface SoilCapabilityRoute extends Disposable {
	identity: SoilLayerIdentity
	/**
	 * Decide one resolved coordinate. Pure with respect to the pipeline: it reads the layer and returns a record.
	 *
	 * `null` and `undefined` are both accepted because a geocode result carries `lat`/`lon` as nullable — a caller that
	 * had to narrow them first would be narrowing on this route's behalf, and a coordinate-less answer is a named refusal
	 * here rather than a caller's problem.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => SoilDesignationDecision
}

export interface SoilCapabilityRouteOptions {
	/**
	 * The sealed layer to read. Required: there is no default layer, and a route that guessed one would report a survey
	 * from a region nobody asked about.
	 */
	databasePath: string
}

/**
 * Build the route against one sealed layer.
 *
 * Everything that would make the route answer a well-formed wrong thing is refused by the reader's own constructor — a
 * manifest naming a different product, a coverage table with no rows, a vocabulary with no classes. Each of those would
 * otherwise present as a route that simply never fires, which on a receipt is indistinguishable from a region the
 * authority genuinely has not surveyed.
 */
export function createSoilCapabilityRoute(options: SoilCapabilityRouteOptions): SoilCapabilityRoute {
	const lookup = new SoilCapabilityLookup({ databasePath: options.databasePath })

	return createDesignationRoute(lookup, {
		read: (latitude, longitude) => lookup.lookup(latitude, longitude),
		refusalFor: (reading) =>
			reading.kind === SoilReadingKind.Unknown || !reading.distribution ? "outside_surveyed_area" : undefined,
		toObservation: (reading, latitude, longitude) =>
			toObservation(reading, lookup.identity, latitude, longitude, options.databasePath),
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
 * What the survey assigns, in ONE wording — the class never travels without the share it rests on — shared by the
 * one-line description and the marker message.
 */
export function soilCapabilityAssignmentClause(observation: SoilCapabilityObservation): string {
	return observation.topClass
		? `assigns land capability class ${observation.topClass} over ${((observation.topClassShare ?? 0) * 100).toFixed(1)}% of the cell`
		: "mapped this ground and rated no capability class here"
}

/**
 * One line a reader can check the claim from, with the authority, both dates, and the share the class rests on.
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
