/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Converts semantic observations, coverage-qualified absences and layer designations into
 *   `QueryIntentMarker`s on the ordinary result.
 *
 *   A marker is additive and never changes which answer wins, so no code in this module reads or
 *   returns a candidate, coordinate or ordering. The caller converts and attaches the markers, because
 *   `createRuntimePipeline` receives the semantic route as a plain `POIPhraseLookup`.
 *
 *   `QueryIntentMarker.kind` must be a kind that the verdict carries as its top kind or an alternative.
 *   The POI converters therefore return no marker when the verdict carries no POI kind.
 */

import { type QueryIntentMarker, QueryIntentCode, type QueryKind, type QueryKindResult } from "@mailwoman/core/pipeline"

import type { AbsenceObservation } from "#observations/absence-route"
import {
	coastalErosionAssignmentClause,
	type CoastalErosionObservation,
	type CoastalErosionRoute,
} from "#observations/coastal-route"
import {
	floodZoneAssignmentClause,
	type AuthorityDesignationObservation,
	type AuthorityDesignationRoute,
} from "#observations/flood-route"
import type { SemanticObservation } from "#observations/semantic-route"
import {
	soilCapabilityAssignmentClause,
	type SoilCapabilityObservation,
	type SoilCapabilityRoute,
} from "#observations/soil-route"
import {
	zoningAssignmentClause,
	type ZoningDesignationObservation,
	type ZoningDesignationRoute,
} from "#observations/zoning-route"

/**
 * The `family:rule` mechanism for a category chosen from an affordance assertion.
 */
export const SEMANTIC_AFFORDS_MECHANISM = "semantic:affords"

/**
 * The `family:rule` mechanism for an absence qualified by exclusion-grade coverage.
 */
export const SEMANTIC_ABSENCE_MECHANISM = "semantic:absence"

/**
 * The `family:rule` mechanism for a designation from the EA flood-zone layer.
 *
 * Each designation layer has its own rule under the `layer` family, so a reader
 * can tell the markers on one answer apart by authority.
 */
export const FLOOD_ZONE_DESIGNATION_MECHANISM = "layer:flood_zone"

/**
 * The `family:rule` mechanism for a reading from the NRCS SSURGO soil-capability layer.
 */
export const SOIL_CAPABILITY_DESIGNATION_MECHANISM = "layer:soil_capability"

/**
 * The `family:rule` mechanism for a reading from the EA coastal-erosion layer.
 */
export const COASTAL_EROSION_DESIGNATION_MECHANISM = "layer:coastal_erosion"

/**
 * The `family:rule` mechanism for a reading from a planning authority's zoning layer.
 */
export const ZONING_DESIGNATION_MECHANISM = "layer:zoning"

/**
 * The query kinds that a POI observation marker may carry.
 */
const POI_KINDS: ReadonlySet<QueryKind> = new Set<QueryKind>(["poi_query", "poi_category"])

/**
 * Returns the POI kind that the verdict carries as its top kind or an alternative, or `null`.
 */
export function poiObservationKind(verdict: QueryKindResult): QueryKind | null {
	if (POI_KINDS.has(verdict.kind)) return verdict.kind

	return verdict.alternatives.find(({ kind }) => POI_KINDS.has(kind))?.kind ?? null
}

/**
 * Reads one designation route at a coordinate and returns one marker when it fires.
 *
 * A missing route or a refusal yields no markers.
 */
function designationMarkers<Observation>(
	route:
		| {
				observe: (
					latitude: number | null | undefined,
					longitude: number | null | undefined
				) => { fired: true; observation: Observation } | { fired: false; refusal: string }
		  }
		| undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult,
	toMarker: (observation: Observation, verdict: QueryKindResult) => QueryIntentMarker
): QueryIntentMarker[] {
	if (!route) return []

	const decision = route.observe(latitude, longitude)

	return decision.fired ? [toMarker(decision.observation, verdict)] : []
}

/**
 * Converts drained semantic observations into markers for one query's verdict.
 *
 * Each observation gets its own marker so that every category keeps its own assertion.
 */
export function semanticObservationMarkers(
	observations: ReadonlyArray<SemanticObservation>,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	const kind = poiObservationKind(verdict)

	if (!kind) return []

	return observations.map((observation) => ({
		kind,
		code: QueryIntentCode.POICategory,
		mechanism: SEMANTIC_AFFORDS_MECHANISM,
		message:
			`"${observation.matchedPhrase}" names the activity ${observation.activity}, which ${observation.concept} ` +
			`asserts it affords (${observation.assertion.modality}) — so the query was answered as ` +
			`${observation.mapping.vocabulary}:${observation.categoryID}.`,
		evidence: {
			categoryID: observation.categoryID,
			activity: observation.activity,
			concept: observation.concept,
			matchedPhrase: observation.matchedPhrase,
			phraseLexiconID: observation.phraseLexiconID,
			phraseLexiconVersion: observation.phraseLexiconVersion,
			phraseProvenance: observation.phraseProvenance,
			phraseAttestation: observation.phraseAttestation,
			localeScope: observation.localeScope,
			declaredLocales: observation.declaredLocales,
			localeCountry: observation.localeCountry,
			assertion: observation.assertion,
			mapping: observation.mapping,
			mappedKindCount: observation.mappedKindCount,
			modelVersion: observation.modelVersion,
		},
	}))
}

/**
 * Converts one coverage-qualified absence into a marker for the query's verdict.
 *
 * The evidence carries the full coverage record so that a reader can re-derive the absence claim.
 */
export function absenceObservationMarker(
	observation: AbsenceObservation,
	verdict: QueryKindResult
): QueryIntentMarker | null {
	const kind = poiObservationKind(verdict)

	if (!kind) return null

	const { coverage } = observation

	return {
		kind,
		code: QueryIntentCode.CoverageQualifiedAbsence,
		mechanism: SEMANTIC_ABSENCE_MECHANISM,
		message:
			`No establishment affording ${observation.activity} is present within the searched area: the coverage layer ` +
			`surveyed cell ${coverage.h3CellIndex} for ${coverage.surveyedCategoryID} and holds none there.`,
		evidence: {
			categoryID: observation.categoryID,
			activity: observation.activity,
			concept: observation.concept,
			assertion: observation.assertion,
			mapping: observation.mapping,
			modelVersion: observation.modelVersion,
			coverage,
			searchCenter: observation.searchCenter,
			resultsReturned: observation.resultsReturned,
			resultsInCell: observation.resultsInCell,
		},
	}
}

/**
 * Returns the flood designation marker for a coordinate, or no markers when the route is absent or refuses.
 *
 * Designation markers use the verdict's top kind.
 * A designation does not come from query intent, so it has no kind of its own.
 *
 * The message states what the authority's map assigns.
 * It makes no claim that the location will flood.
 */
export function authorityDesignationMarkers(
	route: AuthorityDesignationRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	return designationMarkers(route, latitude, longitude, verdict, authorityDesignationMarker)
}

/**
 * Converts one flood designation observation into a marker.
 * Callers normally use {@link authorityDesignationMarkers}.
 */
export function authorityDesignationMarker(
	observation: AuthorityDesignationObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: FLOOD_ZONE_DESIGNATION_MECHANISM,
		message:
			`${observation.extent.authority}'s ${observation.layer.name} (${observation.layer.sourceVintage}) ${floodZoneAssignmentClause(observation)} ` +
			`at the resolved coordinate. This states what the authority's map assigns at a location, not whether a property will flood.`,
		evidence: {
			reading: observation.reading,
			...(observation.code ? { code: observation.code } : {}),
			...(observation.definition ? { definition: observation.definition } : {}),
			...(observation.areaID ? { areaID: observation.areaID } : {}),
			containment: observation.containment,
			...(observation.coverage ? { coverage: observation.coverage } : {}),
			indexCellIndex: observation.indexCellIndex,
			extent: observation.extent,
			limits: observation.limits,
			layer: observation.layer,
			coordinate: observation.coordinate,
		},
	}
}

/**
 * Returns the soil-capability marker for a coordinate, or no markers when the route is absent or refuses.
 *
 * The marker shares the `authority_designation` code with the other layer markers.
 * Its message always pairs the top class with the share of the cell it covers,
 * because the top class may hold only a plurality.
 *
 * The message states what the survey assigns to the map unit.
 * It makes no claim that the land can be farmed.
 */
export function soilCapabilityMarkers(
	route: SoilCapabilityRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	return designationMarkers(route, latitude, longitude, verdict, soilCapabilityMarker)
}

/**
 * Converts one soil-capability observation into a marker.
 * Callers normally use {@link soilCapabilityMarkers}.
 */
export function soilCapabilityMarker(
	observation: SoilCapabilityObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: SOIL_CAPABILITY_DESIGNATION_MECHANISM,
		message:
			`The USDA NRCS soil survey (${observation.layer.sourceVintage}) ${soilCapabilityAssignmentClause(observation)} at the resolved coordinate. ` +
			`This states what the survey assigns to the map unit covering a location, not whether the land can be farmed.`,
		evidence: {
			reading: observation.reading,
			...(observation.topClass ? { topClass: observation.topClass } : {}),
			...(observation.topClassShare === undefined ? {} : { topClassShare: observation.topClassShare }),
			...(observation.topClassDefinition ? { topClassDefinition: observation.topClassDefinition } : {}),
			distribution: observation.distribution,
			...(observation.surveyArea ? { surveyArea: observation.surveyArea } : {}),
			...(observation.coverage ? { coverage: observation.coverage } : {}),
			indexCellIndex: observation.indexCellIndex,
			limits: observation.limits,
			layer: observation.layer,
			coordinate: observation.coordinate,
		},
	}
}

/**
 * Returns the coastal-erosion marker for a coordinate, or no markers when the route is absent or refuses.
 *
 * NCERM publishes one erosion layer per scenario, including long-range projections.
 * The message includes the scenario key and label so that a projection cannot
 * be read as a present-day designation.
 *
 * NCERM publishes no coverage statement, so the route fires only on a designation.
 * The evidence carries the coverage limit.
 *
 * The message states what the authority's map assigns.
 * It makes no claim that a property will erode.
 */
export function coastalErosionMarkers(
	route: CoastalErosionRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	return designationMarkers(route, latitude, longitude, verdict, coastalErosionMarker)
}

/**
 * Converts one coastal-erosion observation into a marker.
 * Callers normally use {@link coastalErosionMarkers}.
 */
export function coastalErosionMarker(
	observation: CoastalErosionObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: COASTAL_EROSION_DESIGNATION_MECHANISM,
		message:
			`The Environment Agency's coastal erosion mapping (${observation.layer.sourceVintage}) ${coastalErosionAssignmentClause(observation)}, under scenario ` +
			`${observation.scenario.key} — ${observation.scenario.label}. This states what the authority's map assigns at a ` +
			"location under one named scenario, not whether a property will erode.",
		evidence: {
			reading: observation.reading,
			scenario: observation.scenario,
			designations: observation.designations,
			containment: observation.containment,
			...(observation.coverage ? { coverage: observation.coverage } : {}),
			indexCellIndex: observation.indexCellIndex,
			limits: observation.limits,
			coverageLimit: observation.coverageLimit,
			layer: observation.layer,
			coordinate: observation.coordinate,
		},
	}
}

/**
 * Returns the zoning marker for a coordinate, or no markers when the route is absent or refuses.
 *
 * The message leads with the authority's own zone code and puts the publisher's generic type beside it.
 * The generic type cannot recover the local code, because some local codes
 * map to more than one generic type.
 * The message also includes the plan name.
 *
 * `currentPlan = 1` means the plan is not superseded.
 * It does not mean the plan is in force today, so the evidence carries the
 * plan window for the reader to check.
 *
 * The message states what a plan assigns.
 * It makes no claim about what may be built there.
 */
export function zoningDesignationMarkers(
	route: ZoningDesignationRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	return designationMarkers(route, latitude, longitude, verdict, zoningDesignationMarker)
}

/**
 * Converts one zoning observation into a marker.
 * Callers normally use {@link zoningDesignationMarkers}.
 */
export function zoningDesignationMarker(
	observation: ZoningDesignationObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: ZONING_DESIGNATION_MECHANISM,
		message:
			`${zoningAssignmentClause(observation)}. This states what an adopted plan assigns at a location, in the authority's own vocabulary, ` +
			"not what may be built there — the publisher states its data are not legal definitions and that original data " +
			"should be sourced directly from the relevant Local Authority.",
		evidence: {
			reading: observation.reading,
			designations: observation.designations,
			containment: observation.containment,
			...(observation.coverage ? { coverage: observation.coverage } : {}),
			indexCellIndex: observation.indexCellIndex,
			limits: observation.limits,
			coverageLimit: observation.coverageLimit,
			layer: observation.layer,
			coordinate: observation.coordinate,
		},
	}
}

/**
 * The optional designation layer routes that a caller can attach to a geocode.
 *
 * `GeocodeDeps` extends this interface.
 * The caller opens each route, so the geocode core never resolves a layer path itself.
 *
 * When a route is absent, the layer is never read and the result is unchanged.
 *
 * Each route reads the coordinate of the finished result and contributes at most one marker.
 */
export interface LayerDesignationRoutes {
	/**
	 * The EA Flood Map for Planning route.
	 *
	 * Inside England, a location with no flood polygon is Flood Zone 1,
	 * so this route reports a designated absence.
	 */
	authorityDesignationRoute?: AuthorityDesignationRoute
	/**
	 * The NRCS SSURGO soil-capability route.
	 */
	soilCapabilityRoute?: SoilCapabilityRoute
	/**
	 * The EA coastal-erosion route.
	 *
	 * NCERM publishes no coverage statement, so this route fires only on a designation.
	 */
	coastalErosionRoute?: CoastalErosionRoute
	/**
	 * The Irish zoning route.
	 *
	 * It fires only on a designation, because an absent zoning polygon has several indistinguishable causes.
	 */
	zoningDesignationRoute?: ZoningDesignationRoute
}

/**
 * Returns the designation markers from every attached layer for one resolved coordinate.
 *
 * The markers always appear in flood, soil, coastal, zoning order.
 * A session without routes gets an empty list.
 */
export function layerDesignationMarkers(
	routes: LayerDesignationRoutes,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	return [
		...authorityDesignationMarkers(routes.authorityDesignationRoute, latitude, longitude, verdict),
		...soilCapabilityMarkers(routes.soilCapabilityRoute, latitude, longitude, verdict),
		...coastalErosionMarkers(routes.coastalErosionRoute, latitude, longitude, verdict),
		...zoningDesignationMarkers(routes.zoningDesignationRoute, latitude, longitude, verdict),
	]
}
