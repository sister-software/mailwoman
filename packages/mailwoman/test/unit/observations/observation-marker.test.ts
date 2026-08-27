/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the one carrier both observation routes use to reach a caller.
 *
 *   Two properties are asserted rather than described, because both are what the marker contract promises
 *   and neither is visible from a marker in isolation: the observation's whole authority survives the
 *   conversion, and a verdict carrying no POI kind produces no marker instead of one naming a kind the
 *   result does not hold.
 *
 *   The semantic half is driven by the committed route, so the evidence the marker carries is the evidence
 *   a real firing produces. The absence half is built from a synthetic observation, because a real one
 *   needs a sealed coverage layer and the carrier reads the record rather than the layer.
 */

import { QueryIntentCode, type QueryKindResult } from "@mailwoman/core/pipeline"
import {
	type AbsenceObservation,
	absenceObservationMarker,
	poiObservationKind,
	SEMANTIC_ABSENCE_MECHANISM,
	SEMANTIC_AFFORDS_MECHANISM,
	createSemanticObservationRoute,
	semanticObservationMarkers,
} from "mailwoman/observations"
import { describe, expect, it } from "vitest"

const route = await createSemanticObservationRoute()

/**
 * A verdict whose top kind is the POI branch, which is what a query the route claimed produces.
 */
const POI_VERDICT: QueryKindResult = { kind: "poi_query", confidence: 0.9, alternatives: [] }

/**
 * A verdict that named the POI reading below its structural incumbent. The marker still has a kind to name, and it is
 * the one in `alternatives`.
 */
const ALTERNATIVE_VERDICT: QueryKindResult = {
	kind: "structured_address",
	confidence: 0.8,
	alternatives: [{ kind: "poi_category", confidence: 0.4 }],
}

const ADDRESS_VERDICT: QueryKindResult = { kind: "structured_address", confidence: 0.9, alternatives: [] }

/**
 * One coverage-qualified absence, shaped as the absence route records it.
 */
const ABSENCE: AbsenceObservation = {
	categoryID: "pharmacy",
	concept: "pharmacy",
	activity: "obtain_medication",
	assertion: {
		id: "pharmacy-affords-obtain-medication",
		relation: "affords",
		modality: "necessary",
		provenance: { source: "mailwoman-curated", authoredAt: "2026-08-26" },
	},
	mapping: {
		id: "poi-taxonomy-pharmacy",
		vocabulary: "poi-taxonomy",
		externalID: "pharmacy",
		provenance: { source: "mailwoman-curated", authoredAt: "2026-08-26" },
	},
	modelVersion: "0.1.0",
	coverage: {
		h3Cell: 1,
		h3CellIndex: "861fb44c7ffffff",
		resolution: 6,
		basis: "surveyed",
		completeness: 0.6665,
		observedRows: 0,
		surveyedCategoryID: "pharmacy",
		layer: {
			name: "poi",
			version: "260627",
			tier: "build-local",
			license: "ODbL-1.0",
			source: "osm",
			sourceVintage: "260627",
			buildCmd: "gazetteer build poi",
			buildSHA: "abc1234",
			createdAt: "2026-08-27T00:00:00.000Z",
		},
		databasePath: "/scratch/coverage.db",
	},
	searchCenter: { latitude: 48.82, longitude: 1.7553 },
	resultsReturned: 0,
	resultsInCell: 0,
} as AbsenceObservation

function semanticMarkers(verdict: QueryKindResult) {
	route.takeObservations()
	route.lookup("where can i pick up a prescription", "en-US")

	return semanticObservationMarkers(route.takeObservations(), verdict)
}

describe("the kind a marker names", () => {
	it("takes the top kind when the verdict routed as a POI query", () => {
		expect(poiObservationKind(POI_VERDICT)).toBe("poi_query")
	})

	it("takes the alternative when the POI reading was scored below its incumbent", () => {
		expect(poiObservationKind(ALTERNATIVE_VERDICT)).toBe("poi_category")
	})

	it("finds none on a verdict that named no POI kind at all", () => {
		expect(poiObservationKind(ADDRESS_VERDICT)).toBeNull()
	})
})

describe("a semantic observation as a marker", () => {
	it("names the rule that produced it and the code a consumer branches on", () => {
		const [marker] = semanticMarkers(POI_VERDICT)

		expect(marker).toBeDefined()
		expect(marker!.kind).toBe("poi_query")
		expect(marker!.code).toBe(QueryIntentCode.POICategory)
		expect(marker!.mechanism).toBe(SEMANTIC_AFFORDS_MECHANISM)
		expect(marker!.message).toContain("obtain_medication")
	})

	// The `pharmacy` member of the set, picked by its concept rather than by position: en-US admits both wave-1 kinds,
	// and a marker read off `[0]` would be asserting whichever concept sorts first.
	it("carries the whole authority, so the marker can be checked rather than taken", () => {
		const markers = semanticMarkers(POI_VERDICT)
		const marker = markers.find(({ evidence }) => evidence?.["concept"] === "pharmacy")
		const evidence = marker!.evidence!

		expect(evidence["categoryID"]).toBe("pharmacy")
		expect(evidence["activity"]).toBe("obtain_medication")
		expect(evidence["concept"]).toBe("pharmacy")

		expect(evidence["assertion"]).toMatchObject({
			id: "pharmacy-affords-obtain-medication",
			relation: "affords",
			modality: "necessary",
			countries: null,
		})

		expect(evidence["mapping"]).toMatchObject({ vocabulary: "poi-taxonomy", externalID: "pharmacy" })
		expect(evidence["phraseAttestation"]).toMatchObject({ kind: "committed-query" })
		expect(evidence["localeCountry"]).toBe("US")
		expect(evidence["mappedKindCount"]).toBe(2)
		expect(evidence["modelVersion"]).toBeTruthy()
	})

	// One marker per member, each naming its own concept and its own assertion. Folding the set into one marker would
	// lose which authority put which class in it, which is the one thing this carrier exists to keep.
	it("emits one marker per member of a plural set, each with its own authority", () => {
		const markers = semanticMarkers(POI_VERDICT)

		expect(markers.map(({ evidence }) => evidence?.["concept"])).toEqual(["drugstore", "pharmacy"])

		expect(markers.map(({ evidence }) => (evidence!["assertion"] as { id: string }).id)).toEqual([
			"drugstore-affords-obtain-medication",
			"pharmacy-affords-obtain-medication",
		])
	})

	it("produces no marker on a verdict carrying no POI kind, rather than inventing one", () => {
		expect(semanticMarkers(ADDRESS_VERDICT)).toEqual([])
	})

	it("produces one marker per observation, so two authorities never fold into one", () => {
		expect(semanticObservationMarkers([], POI_VERDICT)).toEqual([])
	})
})

describe("an absence observation as a marker", () => {
	it("rides the same carrier under its own code", () => {
		const marker = absenceObservationMarker(ABSENCE, POI_VERDICT)

		expect(marker).not.toBeNull()
		expect(marker!.kind).toBe("poi_query")
		expect(marker!.code).toBe(QueryIntentCode.CoverageQualifiedAbsence)
		expect(marker!.mechanism).toBe(SEMANTIC_ABSENCE_MECHANISM)
	})

	it("carries the coverage half in full, so the claim can be re-derived", () => {
		const marker = absenceObservationMarker(ABSENCE, POI_VERDICT)
		const evidence = marker!.evidence!

		expect(evidence["coverage"]).toMatchObject({
			h3CellIndex: "861fb44c7ffffff",
			basis: "surveyed",
			observedRows: 0,
			surveyedCategoryID: "pharmacy",
		})

		expect(evidence["assertion"]).toMatchObject({ modality: "necessary" })
		expect(evidence["resultsInCell"]).toBe(0)
	})

	it("produces nothing on a verdict carrying no POI kind", () => {
		expect(absenceObservationMarker(ABSENCE, ADDRESS_VERDICT)).toBeNull()
	})
})
