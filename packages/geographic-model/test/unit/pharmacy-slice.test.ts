/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authored records — the frozen pharmacy slice and the wave-1 set amended onto it — read through
 *   the artifact a consumer would read.
 *
 *   Every assertion below is made against the COMMITTED artifact or against a fresh compile of the
 *   committed authoring files — never against a fixture built in this file. A fixture would prove that
 *   the compiler works, which `compile.test.ts` already covers; what is unproven until here is that the
 *   records someone actually authored say what the frozen slice says they say.
 *
 *   THE HELD-OUT MAPPING IS ASSERTED, not left to read as an omission. Wave 1 admits a `drugstore`
 *   concept, its US-scoped assertion AND a `poi-taxonomy` mapping; the first two are authored and the
 *   third is not, because one activity reaching two mapped kinds refuses the semantic route at
 *   construction while the query surface still carries a single category id. An absent mapping and a
 *   forgotten one look identical in the artifact, so the tests below state which of the two this is.
 *
 *   The freshness check compares PARSED values rather than bytes. A committed artifact is the
 *   generator's output run through `oxfmt`, which inlines short arrays, so a byte comparison against
 *   `serializeCompiledModel` would fail on formatting the repository itself applies. Byte determinism
 *   is asserted where it is meaningful instead: between two compiles, and between the committed
 *   artifact and a fresh compile once both are canonically serialized.
 *
 *   Frozen slice: `docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md` §4 (#1917); wave-1
 *   amendment: the same record's §4.1 (#1961), authored by #1963.
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
const DRUGSTORE = toConceptID("drugstore")
const OBTAIN_MEDICATION = toConceptID("obtain_medication")
const AFFORDS = toRelationID("affords")

/**
 * The external category the slice maps into. The mapping names it as a string; this is the same string, resolved
 * through the package that owns the vocabulary.
 */
const POI_CATEGORY = toPOICategoryID("pharmacy")

/**
 * The external category wave 1's held-out mapping would name. Nothing maps onto it today, and the read-back below is
 * what keeps that a decision rather than a dead identifier.
 */
const DRUGSTORE_CATEGORY = toPOICategoryID("drugstore")

function authoredDocument(): GeographicModelDocument {
	return loadGeographicModelDirectory(packagedModelPaths().source)
}

describe("the authored pharmacy records", () => {
	it("loads and compiles", () => {
		const model = compileAuthoredGeographicModel()

		expect(model.modelVersion).toBe("0.2.0")

		expect(model.concepts.map((concept) => concept.id)).toEqual([
			"activity",
			"drugstore",
			"establishment",
			"healthcare_facility",
			"obtain_medication",
			"pharmacy",
			"place",
		])
	})

	// `defeasible` is the wave-1 vocabulary correction, and it is a statement about the RELATION: whether `affords`
	// assertions admit exceptions at all. Under `hard` semantics an exception is a defect in the record set, which is a
	// claim only `necessary` and `prohibited` make — so a `strongly_expected` assertion had no defined reading beside a
	// `necessary` one until this moved.
	it("declares `affords` as a defeasible establishment→activity relation", () => {
		const relation = compileAuthoredGeographicModel().relations.find((entry) => entry.id === AFFORDS)

		expect(relation).toBeDefined()
		expect(relation?.domainKinds).toEqual(["establishment"])
		expect(relation?.rangeKinds).toEqual(["activity"])
		expect(relation?.transitive).toBe(false)
		expect(relation?.symmetric).toBe(false)
		expect(relation?.semantics).toBe(RelationSemantics.Defeasible)
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

		// `drugstore` is a kind of `establishment` DIRECTLY. The external hierarchy puts it under `retail`, disjoint
		// from `health_and_medical`, and `healthcare_facility` is premises that exist to provide healthcare — which
		// retail premises with a dispensing counter do not. Placing it there would give every later healthcare class
		// a retail ancestor.
		expect(closure.get(String(DRUGSTORE))).toEqual(["establishment", "place"])
		expect(closure.get(String(DRUGSTORE))).not.toContain("healthcare_facility")
	})

	it("derives nothing, because no ancestor asserts anything", () => {
		// Both affordances are authored on leaves — `pharmacy` and `drugstore` have no descendants — and the only
		// ancestor either of them has that COULD assert (`establishment`) asserts nothing, deliberately: a claim
		// authored there would be inherited by every later establishment class. So `isA` inheritance has nothing to
		// materialize. An empty table here is the truthful answer, not an unread one — `compile.test.ts` exercises
		// the derivation itself.
		const model = readCompiledGeographicModel()
		const everyAncestor = new Set(model.inheritanceClosure.flatMap((entry) => entry.ancestors.map(String)))

		const ancestorsWithAssertions = model.concepts
			.filter((concept) => concept.assertions.length && everyAncestor.has(String(concept.id)))
			.map((concept) => String(concept.id))

		expect(ancestorsWithAssertions).toEqual([])
		expect(model.derivedFacts).toEqual([])
		expect(model.observations).toEqual([])
	})
})

describe("the wave-1 records", () => {
	it("carries the `drugstore` concept the amendment admits, with provenance naming the measured gap", () => {
		const concept = compileAuthoredGeographicModel().concepts.find((entry) => entry.id === DRUGSTORE)

		expect(concept).toBeDefined()
		expect(concept?.kind).toBe("establishment")
		expect(concept?.isA).toEqual(["establishment"])
		expect(concept?.status).toBe("active")
		expect(concept?.provenance.source).toBe("mailwoman-curated")
		expect(concept?.provenance.sourceRecord).toContain("§4.1")
		expect(concept?.provenance.sourceVersion).toContain("2026-07-22.0")
		expect(concept?.provenance.authoredAt).toBe("2026-08-27")
	})

	it("scopes the drugstore affordance to the US, at the strength the evidence carries", () => {
		const concept = compileAuthoredGeographicModel().concepts.find((entry) => entry.id === DRUGSTORE)
		const assertion = concept?.assertions.find((entry) => entry.relation === AFFORDS)

		expect(assertion?.id).toBe("drugstore-affords-obtain-medication")
		expect(assertion?.target).toBe(OBTAIN_MEDICATION)

		// Not `necessary`: the attested material says a US drugstore CHARACTERISTICALLY dispenses, and neither a
		// locale-scoped synonym nor a row count is a census of dispensing.
		expect(assertion?.modality).toBe(Modality.StronglyExpected)

		// The one country a committed record scopes the class to. FR is a measured zero on the shipped layer, so a
		// claim reaching there would range over nothing.
		expect(assertion?.countries).toEqual(["US"])
		expect(assertion?.countries).not.toContain("FR")
		expect(assertion?.provenance.sourceRecord).toContain("curated-overlay.json")
	})

	it("authors no mapping for it, and says so where a reader will look", () => {
		const model = compileAuthoredGeographicModel()
		const concept = model.concepts.find((entry) => entry.id === DRUGSTORE)

		// The whole mapping table, so a mapping added anywhere trips this rather than only one added under the id
		// this test happened to guess.
		expect(model.mappings.map((mapping) => mapping.concept)).toEqual([PHARMACY])
		expect(concept?.provenance.notes).toContain("NOT authored")

		// The category the held-out mapping would name, read back through the vocabulary's owner. An identifier that
		// stopped resolving would make the hold a dead reference rather than a deferred one, and nothing else would
		// notice until the mapping landed.
		const category = getPOICategory(String(DRUGSTORE_CATEGORY))

		expect(category?.id).toBe(DRUGSTORE_CATEGORY)
		expect(category?.hierarchy).toEqual(["retail", "drugstore"])
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

		expect(index.relation(AFFORDS)?.semantics).toBe(RelationSemantics.Defeasible)
		expect(index.ancestorsOf(PHARMACY)).toEqual(["establishment", "healthcare_facility", "place"])
	})

	it("distinguishes a concept it carries from one it has never heard of", () => {
		const index = createGeographicModelIndex(readCompiledGeographicModel())

		// The model carries `pharmacy` and has derived nothing about it; it does not carry `chemist` at all, which
		// is a different answer and stays a different answer.
		expect(index.derivedFactsAbout(PHARMACY)).toEqual([])
		expect(index.derivedFactsAbout(toConceptID("chemist"))).toBeUndefined()
	})

	// Three empty answers about `drugstore` that mean three different things, asserted together because the lookups
	// return the same value for all of them and a reader meeting one alone would take it for the others. The model
	// CARRIES the concept and states what it affords; nothing has been DERIVED about it; and no external identifier
	// translates into it, which is the held-out mapping and not an absent class.
	it("carries `drugstore` while answering nothing for its external identifier", () => {
		const index = createGeographicModelIndex(readCompiledGeographicModel())

		expect(index.concept(DRUGSTORE)).toBeDefined()
		expect(index.concept(DRUGSTORE)?.assertions).toHaveLength(1)
		expect(index.derivedFactsAbout(DRUGSTORE)).toEqual([])
		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, DRUGSTORE_CATEGORY)).toEqual([])
	})
})
