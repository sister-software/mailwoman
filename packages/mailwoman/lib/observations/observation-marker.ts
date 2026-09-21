/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one carrier both observation routes use to reach a caller: a semantic observation and a
 *   coverage-qualified absence each become a `QueryIntentMarker` on the ordinary result, and neither gets a
 *   private path of its own.
 *
 *   the marker interface is the whole reason this is the carrier, and it is inviolable here. A marker is
 *   additive, attributed, and always accompanied by the ordinary answer. it never changes which answer wins.
 *   That is exactly what an observation is — the authority behind an answer the pipeline had already
 *   reached — so nothing in this module reads or returns a candidate, a coordinate, or an ordering. The
 *   `mechanism` field names the rule in the `family:rule` form the vocabulary uses, and `evidence` carries
 *   the assertion, the mapping and every provenance record, so a reader can check the claim rather than
 *   take it.
 *
 *   the pipeline still learns nothing. `createRuntimePipeline` takes the semantic route as a plain
 *   `POIPhraseLookup` and is told nothing about where the evidence came from — the property that keeps the
 *   integration point one optional argument instead of a branch. So the conversion happens at the caller.
 *   The caller built the route and already holds it: run the query, drain the route, convert, attach. A pipeline
 *   that attached these itself would have to know the difference.
 *
 *   A marker must name A kind the verdict carries. `QueryIntentMarker.kind` is documented as a kind present
 *   in the result as either the top kind or an alternative, and a marker naming one that is in neither is a
 *   producer bug. So the conversion is handed the verdict and finds the POI kind in it. a verdict carrying
 *   none yields no marker rather than an invented one. That silence is a real reading — the observation was
 *   recorded on a query the classifier did not route as a POI query — and it is not the same as there being
 *   nothing to say.
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
 * `family:rule` for a category chosen from an affordance assertion.
 */
export const SEMANTIC_AFFORDS_MECHANISM = "semantic:affords"

/**
 * `family:rule` for an absence qualified by exclusion-grade coverage.
 */
export const SEMANTIC_ABSENCE_MECHANISM = "semantic:absence"

/**
 * `family:rule` for a designation read out of the EA flood-zone layer.
 *
 * The rule half names the layer rather than the shape of the claim, so a reader meeting
 * two designation markers on one answer can tell which authority spoke.
 * A later overlay writes its own rule under the same `layer` family.
 */
export const FLOOD_ZONE_DESIGNATION_MECHANISM = "layer:flood_zone"

/**
 * `family:rule` for a reading out of the nrcs ssurgo soil-capability layer —
 * the second rule under the `layer` family.
 */
export const SOIL_CAPABILITY_DESIGNATION_MECHANISM = "layer:soil_capability"

/**
 * `family:rule` for a reading out of the EA coastal-erosion layer — the third rule under the `layer` family.
 */
export const COASTAL_EROSION_DESIGNATION_MECHANISM = "layer:coastal_erosion"

/**
 * `family:rule` for a reading out of a planning authority's zoning layer —
 * the fourth rule under the `layer` family.
 */
export const ZONING_DESIGNATION_MECHANISM = "layer:zoning"

/**
 * The kinds a POI observation may name.
 *
 * Both route as the POI branch, and the classifier reports whichever one its scorers reached.
 */
const POI_KINDS: ReadonlySet<QueryKind> = new Set<QueryKind>(["poi_query", "poi_category"])

/**
 * The POI kind the verdict carries, as the top kind or as an alternative, or `null` when it carries none.
 */
export function poiObservationKind(verdict: QueryKindResult): QueryKind | null {
	if (POI_KINDS.has(verdict.kind)) return verdict.kind

	return verdict.alternatives.find(({ kind }) => POI_KINDS.has(kind))?.kind ?? null
}

/**
 * The route-to-marker frame every designation layer shares: no route contributes nothing,
 * a named silence contributes nothing, and a fired observation becomes exactly one marker.
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
 * Turn drained semantic observations into markers on one query's verdict.
 *
 * One marker per observation: each names a distinct assertion, and folding several
 * into one would lose which authority decided which category.
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
 * Turn one coverage-qualified absence into a marker on the query's verdict.
 *
 * The coverage half rides in full — cell, basis, completeness, observed rows
 * and the layer's own manifest identity — because an absence claim a reader cannot
 * re-derive from the receipt is an assertion rather than a measurement.
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
 * Turn one authority designation into a marker on a geocode verdict.
 *
 * The kind is the verdict'S own TOP kind, and that is the settled answer to the
 * survey's open question rather than an omission.
 * `QueryIntentMarker.kind` is by agreement a kind the verdict carries.
 *
 * A designation is not raised by intent at all — nothing about "10 Downing
 * Street" asks for a flood zone — so there is no kind of its own to name
 * and naming the top kind satisfies the interface literally.
 *
 * `declared_ambiguity` is the precedent for a marker raised at resolve time rather than by the classifier.
 * This one goes one step further and names no kind of its own, which is why the distinction
 * is written down here and in the layer interface instead of being inferred from the code.
 *
 * The message reports what the authority'S MAP assigns, never whether the location will flood.
 * The authority itself declines the second statement, and a wording that blurred them
 * would be this program's invention rather than the authority's.
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
 * The conversion proper — see {@link authorityDesignationMarkers} for the caller-facing shape.
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
 * Turn one soil-capability reading into a marker on a geocode verdict.
 *
 * Same code, same family, different rule.
 * It shares `authority_designation` and the `layer` mechanism family with the flood marker,
 * because both report what an authority designates at a resolved coordinate.
 *
 * The rule half names the layer, so a reader meeting two designation markers on
 * one answer can tell which authority spoke.
 *
 * The class never travels without the share IT rests on.
 * Nrcs's own map-unit aggregation ships its dominant-condition class beside the share that class
 * covers, with an observed minimum of 2%, and this marker reproduces that pairing at cell grain.
 *
 * A message carrying "class 2" alone would manufacture certainty from a plurality.
 *
 * The message reports what the survey assigns TO the MAP unit covering the location,
 * never whether the land can be farmed.
 * The authority itself declines the second statement — its data are "intended for planning purposes
 * only" — and a wording that blurred them would be this program's invention rather than the authority's.
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
 * The conversion proper — see {@link soilCapabilityMarkers} for the caller-facing shape.
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
 * Turn one coastal-erosion reading into a marker on a geocode verdict.
 *
 * Same code, same family, different rule.
 * The third under the `layer` family, sharing `authority_designation` with the flood and soil
 * markers because all three report what an authority designates at a resolved coordinate.
 *
 * The rule half names the layer, so a reader meeting several designation markers
 * on one answer can tell which authority spoke.
 *
 * The scenario travels IN the message rather than only IN the evidence.
 * Ncerm publishes twelve erosion-zone layers and they answer twelve different questions.
 *
 * A message reading "at erosion risk" without naming which one would let a 2105 projection
 * under a 95th-percentile sea-level-rise allowance be read as a present-day designation.
 * So the scenario key and its plain-language label are in the sentence itself.
 *
 * The message also records the coverage limit, because this layer's silence is not a reassurance.
 * The Environment Agency publishes no coverage statement for ncerm, so an absent designation
 * says nothing — and the marker only ever fires on a present one, which is why the limit
 * rides on the evidence rather than being implied by the marker's absence.
 *
 * The message reports what the authority'S mapping assigns at a location,
 * never whether a property will erode.
 * The authority itself declines the second statement — its data "cannot provide
 * details for individual properties" — and a wording that blurred them would be
 * this program's invention rather than the authority's.
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
 * The conversion proper — see {@link coastalErosionMarkers} for the caller-facing shape.
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
 * Turn one zoning reading into a marker on a geocode verdict.
 *
 * Same code, same family, different rule.
 * The fourth under the `layer` family, sharing `authority_designation` with the flood, soil
 * and coastal markers because all four report what an authority designates at a resolved coordinate.
 *
 * The rule half names the layer, so a reader meeting several designation markers
 * on one answer can tell which authority spoke.
 *
 * The authority'S own code is IN the sentence, verbatim, and the generic type rides beside IT.
 * That ordering is the whole vocabulary decision expressed in one string:
 * the publisher's national scheme "complements (rather than replaces) the existing
 * statutory zoning used for each individual plan", in its own words, and a message that
 * led with the generic type would report the summary as the designation.
 *
 * The local code is also the half that cannot be reconstructed — 52 of 795 (authority, local code)
 * pairs take more than one generic type, so the mapping runs one way only.
 *
 * And the plan is IN the sentence too.
 * A zone exists inside a named plan with a stated window, and a designation
 * without one would be a fact about nothing.
 *
 * `currentPlan = 1` means "not superseded" rather than "in force today", so the window
 * travels on the evidence and the comparison against a date is the reader's.
 *
 * The message reports what A plan assigns at a location, never what may be built there.
 * The publisher itself declines the second statement — its data are "not published
 * here as legal definitions of the current actuality" — and a wording that blurred
 * them would be this program's invention rather than the authority's.
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
 * The conversion proper — see {@link zoningDesignationMarkers} for the caller-facing shape.
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
 * The attached spatial layers a caller may hand to a geocode, as one named bundle.
 *
 * One type rather than three fields on the consumer, because {@link layerDesignationMarkers}
 * already reads all of them together and the consumer reads none of them.
 * `GeocodeDeps` extends this, so a fourth layer is one edit here — the route type,
 * its field, its docstring and its entry in the marker list — and none at the call site.
 *
 * Every field is optional and presence is the switch.
 * A boolean would make the consumer resolve a data-root path and open a sealed
 * database on the default construction path.
 *
 * What arrives here instead is a route the caller already built, so the consumer
 * never learns where the artifact lives.
 *
 * Absent — the default everywhere — leaves the geocode result byte-identical to a run without the
 * field existing: the layer is never opened, the coordinate is never re-asked, and no marker appears.
 *
 * Every route runs after the open result is assembled, over the coordinate that result
 * reached, and its answer is carried as one additive marker.
 * Nothing above the marker assembly reads any of them.
 */
export interface LayerDesignationRoutes {
	/**
	 * The EA Flood Map for Planning route (#1989).
	 *
	 * The first of these, and the one whose absence reading is a designation: inside England a location
	 * with no flood polygon is Flood Zone 1 by the Planning Practice Guidance's own definition.
	 */
	authorityDesignationRoute?: AuthorityDesignationRoute
	/**
	 * The nrcs ssurgo soil-capability route (#1991) — a second layer under the same marker code
	 * and `layer` mechanism family, with a rule of its own.
	 *
	 * A separate field rather than a widened first one: the two carry different
	 * observations — a zone code and a containment path against a class distribution,
	 * five shares and two dates — and share only the code.
	 */
	soilCapabilityRoute?: SoilCapabilityRoute
	/**
	 * The EA coastal-erosion route (#1993).
	 *
	 * A third layer, and the one whose absence reading is nothing.
	 * Ncerm publishes no coverage statement, so this route fires on a designation
	 * and stays silent otherwise, which is the opposite of the flood route above.
	 *
	 * One field across both would put one rule over two opposite meanings of an empty answer.
	 */
	coastalErosionRoute?: CoastalErosionRoute
	/**
	 * The Irish zoning route (#1995).
	 *
	 * A fourth layer, and the first whose observation is a vocabulary rather than a code from a closed domain.
	 *
	 * It carries the authority's own zone code verbatim beside the publisher's own
	 * generic classification, because 52 of 795 (authority, local code) pairs take more
	 * than one generic type and the mapping therefore runs one way only.
	 * Its absence reading is nothing, on the same terms as the coastal route above
	 * and for a harder reason: an absent zoning polygon is one of at least four
	 * different things and no product distinguishes them.
	 */
	zoningDesignationRoute?: ZoningDesignationRoute
}

/**
 * Every attached layer's designation for one resolved coordinate, in one call.
 *
 * A list rather than A call PER layer, so a third layer is one edit here and none at the call site.
 * Each route is independently optional and each contributes zero markers when absent,
 * which is what makes an unconfigured session produce the identical marker list —
 * the property the byte-stability tests pin.
 *
 * Order is fixed by the array below rather than by which route happened to be constructed
 * first, so two sessions holding the same layers produce markers in the same order.
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
