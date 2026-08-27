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
import type { AuthorityDesignationObservation, AuthorityDesignationRoute } from "./flood-route.ts"
import type { SemanticObservation } from "./semantic-route.ts"

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
