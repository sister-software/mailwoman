/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The ONE carrier both observation routes use to reach a caller: a semantic observation and a
 *   coverage-qualified absence each become a `QueryIntentMarker` on the ordinary result, and neither gets a
 *   private path of its own.
 *
 *   THE MARKER CONTRACT IS THE WHOLE REASON THIS IS THE CARRIER, and it is inviolable here. A marker is
 *   additive, attributed, and always accompanied by the ordinary answer; it never changes which answer wins.
 *   That is exactly what an observation is — the authority behind an answer the pipeline had already
 *   reached — so nothing in this module reads or returns a candidate, a coordinate, or an ordering. The
 *   `mechanism` field names the rule in the `family:rule` form the vocabulary uses, and `evidence` carries
 *   the assertion, the mapping and every provenance record, so a reader can check the claim rather than
 *   take it.
 *
 *   THE PIPELINE STILL LEARNS NOTHING. `createRuntimePipeline` takes the semantic route as a plain
 *   `POIPhraseLookup` and is told nothing about where the evidence came from — the property that keeps the
 *   integration point one optional argument instead of a branch. So the conversion happens at the CALLER,
 *   which is the side that built the route and therefore already holds it: run the query, drain the route,
 *   convert, attach. A pipeline that attached these itself would have to know the difference.
 *
 *   A MARKER MUST NAME A KIND THE VERDICT CARRIES. `QueryIntentMarker.kind` is documented as a kind present
 *   in the result as either the top kind or an alternative, and a marker naming one that is in neither is a
 *   producer bug. So the conversion is handed the verdict and finds the POI kind in it; a verdict carrying
 *   none yields NO marker rather than an invented one. That silence is a real reading — the observation was
 *   recorded on a query the classifier did not route as a POI query — and it is not the same as there being
 *   nothing to say.
 */

import { type QueryIntentMarker, QueryIntentCode, type QueryKind, type QueryKindResult } from "@mailwoman/core/pipeline"

import type { AbsenceObservation } from "./absence-route.ts"
import type { CoastalErosionObservation, CoastalErosionRoute } from "./coastal-route.ts"
import type { AuthorityDesignationObservation, AuthorityDesignationRoute } from "./flood-route.ts"
import type { SemanticObservation } from "./semantic-route.ts"
import type { SoilCapabilityObservation, SoilCapabilityRoute } from "./soil-route.ts"

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
 * The RULE half names the layer rather than the shape of the claim, so a reader meeting two designation markers on one
 * answer can tell which authority spoke. A later overlay writes its own rule under the same `layer` family.
 */
export const FLOOD_ZONE_DESIGNATION_MECHANISM = "layer:flood_zone"

/**
 * `family:rule` for a reading out of the NRCS SSURGO soil-capability layer — the second rule under the `layer` family.
 */
export const SOIL_CAPABILITY_DESIGNATION_MECHANISM = "layer:soil_capability"

/**
 * `family:rule` for a reading out of the EA coastal-erosion layer — the third rule under the `layer` family.
 */
export const COASTAL_EROSION_DESIGNATION_MECHANISM = "layer:coastal_erosion"

/**
 * The kinds a POI observation may name. Both route as the POI branch, and the classifier reports whichever one its
 * scorers reached.
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
 * Turn drained semantic observations into markers on one query's verdict.
 *
 * One marker per observation: each names a distinct assertion, and folding several into one would lose which authority
 * decided which category.
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
 * The coverage half rides in full — cell, basis, completeness, observed rows and the layer's own manifest identity —
 * because an absence claim a reader cannot re-derive from the receipt is an assertion rather than a measurement.
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
 * THE KIND IS THE VERDICT'S OWN TOP KIND, and that is the settled answer to the survey's open question rather than an
 * omission. `QueryIntentMarker.kind` is contractually a kind the verdict carries; a designation is not raised by intent
 * at all — nothing about "10 Downing Street" asks for a flood zone — so there is no kind of its own to name and naming
 * the top kind satisfies the contract literally. `declared_ambiguity` is the precedent for a marker raised at resolve
 * time rather than by the classifier; this one goes one step further and names no kind of its own, which is why the
 * distinction is written down here and in the layer contract instead of being inferred from the code.
 *
 * The message reports WHAT THE AUTHORITY'S MAP ASSIGNS, never whether the location will flood. The authority itself
 * declines the second statement, and a wording that blurred them would be this program's invention rather than the
 * authority's.
 */
export function authorityDesignationMarkers(
	route: AuthorityDesignationRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	if (!route) return []

	const decision = route.observe(latitude, longitude)

	return decision.fired ? [authorityDesignationMarker(decision.observation, verdict)] : []
}

/**
 * The conversion proper — see {@link authorityDesignationMarkers} for the caller-facing shape.
 */
export function authorityDesignationMarker(
	observation: AuthorityDesignationObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	const assigned = observation.code
		? `assigns ${observation.code}`
		: `assigns no zone — which its own guidance defines as ${observation.definition?.label ?? "the absent case"}`

	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: FLOOD_ZONE_DESIGNATION_MECHANISM,
		message:
			`${observation.extent.authority}'s ${observation.layer.name} (${observation.layer.sourceVintage}) ${assigned} ` +
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
 * SAME CODE, SAME FAMILY, DIFFERENT RULE. It shares `authority_designation` and the `layer` mechanism family with the
 * flood marker, because both report what an authority designates at a resolved coordinate; the rule half names the
 * layer, so a reader meeting two designation markers on one answer can tell which authority spoke.
 *
 * THE CLASS NEVER TRAVELS WITHOUT THE SHARE IT RESTS ON. NRCS's own map-unit aggregation ships its dominant-condition
 * class beside the share that class covers, with an observed minimum of 2%, and this marker reproduces that pairing at
 * cell grain. A message carrying "class 2" alone would manufacture certainty from a plurality.
 *
 * The message reports WHAT THE SURVEY ASSIGNS TO THE MAP UNIT covering the location, never whether the land can be
 * farmed. The authority itself declines the second statement — its data are "intended for planning purposes only" — and
 * a wording that blurred them would be this program's invention rather than the authority's.
 */
export function soilCapabilityMarkers(
	route: SoilCapabilityRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	if (!route) return []

	const decision = route.observe(latitude, longitude)

	return decision.fired ? [soilCapabilityMarker(decision.observation, verdict)] : []
}

/**
 * The conversion proper — see {@link soilCapabilityMarkers} for the caller-facing shape.
 */
export function soilCapabilityMarker(
	observation: SoilCapabilityObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	const assigned = observation.topClass
		? `assigns land capability class ${observation.topClass} over ${((observation.topClassShare ?? 0) * 100).toFixed(1)}% of the cell`
		: "mapped this ground and rated no capability class here"

	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: SOIL_CAPABILITY_DESIGNATION_MECHANISM,
		message:
			`The USDA NRCS soil survey (${observation.layer.sourceVintage}) ${assigned} at the resolved coordinate. ` +
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
 * SAME CODE, SAME FAMILY, DIFFERENT RULE — the third under the `layer` family, sharing `authority_designation` with the
 * flood and soil markers because all three report what an authority designates at a resolved coordinate. The rule half
 * names the layer, so a reader meeting several designation markers on one answer can tell which authority spoke.
 *
 * THE SCENARIO TRAVELS IN THE MESSAGE, NOT ONLY IN THE EVIDENCE. NCERM publishes twelve erosion-zone layers and they
 * answer twelve different questions; a message reading "at erosion risk" without naming which one would let a 2105
 * projection under a 95th-percentile sea-level-rise allowance be read as a present-day designation. So the scenario key
 * and its plain-language label are in the sentence itself.
 *
 * AND THE MESSAGE CARRIES THE COVERAGE LIMIT, because this layer's silence is not a reassurance. The Environment Agency
 * publishes no coverage statement for NCERM, so an absent designation says nothing — and the marker only ever fires on
 * a PRESENT one, which is why the limit rides on the evidence rather than being implied by the marker's absence.
 *
 * The message reports WHAT THE AUTHORITY'S MAPPING ASSIGNS at a location, never whether a property will erode. The
 * authority itself declines the second statement — its data "cannot provide details for individual properties" — and a
 * wording that blurred them would be this program's invention rather than the authority's.
 */
export function coastalErosionMarkers(
	route: CoastalErosionRoute | undefined,
	latitude: number | null | undefined,
	longitude: number | null | undefined,
	verdict: QueryKindResult
): QueryIntentMarker[] {
	if (!route) return []

	const decision = route.observe(latitude, longitude)

	return decision.fired ? [coastalErosionMarker(decision.observation, verdict)] : []
}

/**
 * The conversion proper — see {@link coastalErosionMarkers} for the caller-facing shape.
 */
export function coastalErosionMarker(
	observation: CoastalErosionObservation,
	verdict: QueryKindResult
): QueryIntentMarker {
	const first = observation.designations[0]

	const assigned = first
		? `places the resolved coordinate inside a coastal-erosion zone at ${first.distanceM} m of cumulative erosion`
		: "places the resolved coordinate inside a coastal-erosion zone"

	return {
		kind: verdict.kind,
		code: QueryIntentCode.AuthorityDesignation,
		mechanism: COASTAL_EROSION_DESIGNATION_MECHANISM,
		message:
			`The Environment Agency's coastal erosion mapping (${observation.layer.sourceVintage}) ${assigned}, under scenario ` +
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
 * The attached spatial layers a caller may hand to a geocode, as one named bundle.
 *
 * ONE TYPE RATHER THAN THREE FIELDS ON THE CONSUMER, because {@link layerDesignationMarkers} already reads all of them
 * together and the consumer reads none of them. `GeocodeDeps` extends this, so a fourth layer is one edit HERE — the
 * route type, its field, its docstring and its entry in the marker list — and none at the call site.
 *
 * EVERY FIELD IS OPTIONAL AND PRESENCE IS THE SWITCH. A boolean would make the consumer resolve a data-root path and
 * open a sealed database on the default construction path; what arrives here instead is a route the caller already
 * built, so the consumer never learns where the artifact lives. Absent — the default everywhere — leaves the geocode
 * result byte-identical to a run without the field existing: the layer is never opened, the coordinate is never
 * re-asked, and no marker appears.
 *
 * EVERY ROUTE RUNS AFTER THE OPEN RESULT IS ASSEMBLED, over the coordinate that result reached, and its answer is
 * carried as one additive marker. Nothing above the marker assembly reads any of them.
 */
export interface LayerDesignationRoutes {
	/**
	 * The EA Flood Map for Planning route (#1989) — the first of these, and the one whose absence reading is a
	 * DESIGNATION: inside England a location with no flood polygon is Flood Zone 1 by the Planning Practice Guidance's
	 * own definition.
	 */
	authorityDesignationRoute?: AuthorityDesignationRoute
	/**
	 * The NRCS SSURGO soil-capability route (#1991) — a second layer under the same marker code and `layer` mechanism
	 * family, with a rule of its own. A separate field rather than a widened first one: the two carry different
	 * observations — a zone code and a containment path against a class distribution, five shares and two dates — and
	 * share only the code.
	 */
	soilCapabilityRoute?: SoilCapabilityRoute
	/**
	 * The EA coastal-erosion route (#1993) — a third layer, and the one whose absence reading is NOTHING. NCERM publishes
	 * no coverage statement, so this route fires on a designation and stays silent otherwise, which is the opposite of
	 * the flood route above. One field across both would put one rule over two opposite meanings of an empty answer.
	 */
	coastalErosionRoute?: CoastalErosionRoute
}

/**
 * Every attached layer's designation for one resolved coordinate, in one call.
 *
 * A LIST RATHER THAN A CALL PER LAYER, so a third layer is one edit HERE and none at the call site. Each route is
 * independently optional and each contributes zero markers when absent, which is what makes an unconfigured session
 * produce the identical marker list — the property the byte-stability tests pin.
 *
 * Order is fixed by the array below rather than by which route happened to be constructed first, so two sessions
 * holding the same layers produce markers in the same order.
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
	]
}
