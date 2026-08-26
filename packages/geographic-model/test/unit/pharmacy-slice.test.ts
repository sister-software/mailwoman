/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authored pharmacy slice, read through the artifact a consumer would read.
 *
 *   Every assertion below is made against the COMMITTED artifact or against a fresh compile of the
 *   committed authoring files — never against a fixture built in this file. A fixture would prove that
 *   the compiler works, which `compile.test.ts` already covers; what is unproven until here is that the
 *   records someone actually authored say what the frozen slice says they say.
 *
 *   The freshness check compares PARSED values rather than bytes. A committed artifact is the
 *   generator's output run through `oxfmt`, which inlines short arrays, so a byte comparison against
 *   `serializeCompiledModel` would fail on formatting the repository itself applies. Byte determinism
 *   is asserted where it is meaningful instead: between two compiles, and between the committed
 *   artifact and a fresh compile once both are canonically serialized.
 *
 *   Frozen slice: `docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md` §4 (#1917).
 */

import {
	compileGeographicModel,
	type ConceptID,
	createGeographicModelIndex,
	ExternalVocabulary,
	type GeographicModelDocument,
	Modality,
	RelationSemantics,
	serializeCompiledModel,
	toConceptID,
	toRelationID,
	toRuleID,
	validateGeographicModelDocument,
	ValidationIssueCode,
} from "@mailwoman/geographic-model"
import { loadGeographicModelDirectory } from "@mailwoman/geographic-model/load"
import {
	compileAuthoredGeographicModel,
	packagedModelPaths,
	readCompiledGeographicModel,
	REGENERATE_ARTIFACT_COMMAND,
} from "@mailwoman/geographic-model/scripts/build-artifact"
import { getPOICategory, toPOICategoryID } from "@mailwoman/poi-taxonomy"
import { describe, expect, it } from "vitest"

const PHARMACY = toConceptID("pharmacy")
const OBTAIN_MEDICATION = toConceptID("obtain_medication")
const AFFORDS = toRelationID("affords")

/**
 * The external category the slice maps into. The mapping names it as a string; this is the same string, resolved
 * through the package that owns the vocabulary.
 */
const POI_CATEGORY = toPOICategoryID("pharmacy")

function authoredDocument(): GeographicModelDocument {
	return loadGeographicModelDirectory(packagedModelPaths().source)
}

describe("the authored pharmacy records", () => {
	it("loads and compiles", () => {
		const model = compileAuthoredGeographicModel()

		expect(model.modelVersion).toBe("0.1.0")

		expect(model.concepts.map((concept) => concept.id)).toEqual([
			"activity",
			"establishment",
			"healthcare_facility",
			"obtain_medication",
			"pharmacy",
			"place",
		])
	})

	it("declares `affords` as a hard establishment→activity relation", () => {
		const relation = compileAuthoredGeographicModel().relations.find((entry) => entry.id === AFFORDS)

		expect(relation).toBeDefined()
		expect(relation?.domainKinds).toEqual(["establishment"])
		expect(relation?.rangeKinds).toEqual(["activity"])
		expect(relation?.transitive).toBe(false)
		expect(relation?.symmetric).toBe(false)
		expect(relation?.semantics).toBe(RelationSemantics.Hard)
	})

	it("maps the concept onto a category `@mailwoman/poi-taxonomy` actually carries", () => {
		const mapping = compileAuthoredGeographicModel().mappings.find((entry) => entry.concept === PHARMACY)

		expect(mapping?.vocabulary).toBe(ExternalVocabulary.POITaxonomy)
		expect(mapping?.externalID).toBe(POI_CATEGORY)

		// Read the id back through the vocabulary's owner. A mapping onto an identifier the taxonomy does not
		// carry would be a translation into nothing, and it would look exactly like a working one from here.
		const category = getPOICategory(String(POI_CATEGORY))

		expect(category?.id).toBe(POI_CATEGORY)
		expect(category?.hierarchy).toEqual(["health_and_medical", "pharmacy"])
	})

	it("refuses `activity affords establishment`", () => {
		const document = structuredClone(authoredDocument())
		const activity = document.concepts.find((concept) => concept.id === OBTAIN_MEDICATION)

		expect(activity).toBeDefined()

		// The reversed edge: the activity asserting the establishment class, which is the one direction the
		// relation's declared kinds forbid on both sides at once.
		activity?.assertions.push({
			id: toRuleID("obtain-medication-affords-pharmacy"),
			relation: AFFORDS,
			target: PHARMACY,
			modality: Modality.Necessary,
			provenance: { source: "test" },
		})

		const result = validateGeographicModelDocument(document)

		expect(result.ok).toBe(false)

		const codes = result.ok ? [] : result.issues.map((issue) => issue.code)

		expect(codes).toContain(ValidationIssueCode.DomainKindMismatch)
		expect(codes).toContain(ValidationIssueCode.RangeKindMismatch)
	})

	it("compiles to the same bytes twice", () => {
		const document = authoredDocument()

		expect(serializeCompiledModel(compileGeographicModel(document))).toBe(
			serializeCompiledModel(compileGeographicModel(document))
		)
	})
})

describe("the committed artifact", () => {
	it("is what the authored records compile to", () => {
		expect(readCompiledGeographicModel(), `stale artifact — regenerate with: ${REGENERATE_ARTIFACT_COMMAND}`).toEqual(
			compileAuthoredGeographicModel()
		)
	})

	it("is byte-identical to a fresh compile once both are canonically serialized", () => {
		expect(
			serializeCompiledModel(readCompiledGeographicModel()),
			`stale artifact — regenerate with: ${REGENERATE_ARTIFACT_COMMAND}`
		).toBe(serializeCompiledModel(compileAuthoredGeographicModel()))
	})

	it("carries the ancestry the slice states", () => {
		const closure = new Map(
			readCompiledGeographicModel().inheritanceClosure.map((entry) => [String(entry.concept), entry.ancestors])
		)

		expect(closure.get(String(PHARMACY))).toEqual(["establishment", "healthcare_facility", "place"])
		expect(closure.get(String(OBTAIN_MEDICATION))).toEqual(["activity"])
	})

	it("derives nothing, because no ancestor asserts anything", () => {
		// The affordance is authored on `pharmacy`, which has no descendants, so `isA` inheritance has nothing to
		// materialize. An empty table here is the truthful answer, not an unread one — `compile.test.ts` exercises
		// the derivation itself.
		expect(readCompiledGeographicModel().derivedFacts).toEqual([])
		expect(readCompiledGeographicModel().observations).toEqual([])
	})
})

describe("reading the slice through the runtime lookups", () => {
	it("answers the proposition from the external category id, with provenance", () => {
		const index = createGeographicModelIndex(readCompiledGeographicModel())
		const concepts = index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, POI_CATEGORY)

		expect(concepts).toEqual([PHARMACY])

		const concept = index.concept(concepts[0] as ConceptID)
		const assertion = concept?.assertions.find((entry) => entry.relation === AFFORDS)

		expect(assertion?.target).toBe(OBTAIN_MEDICATION)
		expect(assertion?.modality).toBe(Modality.Necessary)
		expect(assertion?.countries).toBeUndefined()

		// Provenance is the half a consumer cannot reconstruct: who stands behind the claim, and where to read it.
		expect(assertion?.provenance.source).toBe("mailwoman-curated")
		expect(assertion?.provenance.sourceRecord).toContain("2026-08-26-geographic-model-boundaries.md")
		expect(assertion?.provenance.authoredAt).toBe("2026-08-26")
		expect(concept?.provenance.source).toBe("mailwoman-curated")

		expect(index.relation(AFFORDS)?.semantics).toBe(RelationSemantics.Hard)
		expect(index.ancestorsOf(PHARMACY)).toEqual(["establishment", "healthcare_facility", "place"])
	})

	it("distinguishes a concept it carries from one it has never heard of", () => {
		const index = createGeographicModelIndex(readCompiledGeographicModel())

		// The model carries `pharmacy` and has derived nothing about it; it does not carry `chemist` at all, which
		// is a different answer and stays a different answer.
		expect(index.derivedFactsAbout(PHARMACY)).toEqual([])
		expect(index.derivedFactsAbout(toConceptID("chemist"))).toBeUndefined()
		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, toPOICategoryID("drugstore"))).toEqual([])
	})
})
