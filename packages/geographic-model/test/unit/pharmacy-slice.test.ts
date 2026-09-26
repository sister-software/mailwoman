/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The authored records — the frozen pharmacy record set and the wave-1 set amended onto it — read
 * through the artifact a consumer would read.
 *
 * Every assertion is made against the committed artifact or a fresh compile of the committed authoring
 * files, never against a fixture built in this file.
 *
 * The freshness check compares parsed values rather than bytes, because a committed artifact is the
 * generator's output run through `oxfmt`, which inlines short arrays; byte determinism is asserted
 * between two compiles, and between the committed artifact and a fresh compile once both are canonically
 * serialized.
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
 * The external category the record set maps into, resolved through the package that owns the vocabulary.
 */
const POI_CATEGORY = toPOICategoryID("pharmacy")

/**
 * The external category wave 1's second mapping names, read back through the
 * vocabulary's owner because a mapping onto an identifier the taxonomy stopped carrying
 * looks exactly like a working one from inside this package.
 */
const DRUGSTORE_CATEGORY = toPOICategoryID("drugstore")

async function authoredDocument(): Promise<GeographicModelDocument> {
	return loadGeographicModelDirectory((await packagedModelPaths()).source)
}

describe("the authored pharmacy records", () => {
	it("loads and compiles", async () => {
		const model = await compileAuthoredGeographicModel()

		expect(model.modelVersion).toBe("0.3.0")

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

	it("declares `affords` as a defeasible establishment→activity relation", async () => {
		const relation = (await compileAuthoredGeographicModel()).relations.find((entry) => entry.id === AFFORDS)

		expect(relation).toBeDefined()
		expect(relation?.domainKinds).toEqual(["establishment"])
		expect(relation?.rangeKinds).toEqual(["activity"])
		expect(relation?.transitive).toBe(false)
		expect(relation?.symmetric).toBe(false)
		expect(relation?.semantics).toBe(RelationSemantics.Defeasible)
	})

	it("maps the concept onto a category `@mailwoman/poi-taxonomy` actually carries", async () => {
		const mapping = (await compileAuthoredGeographicModel()).mappings.find((entry) => entry.concept === PHARMACY)

		expect(mapping?.vocabulary).toBe(ExternalVocabulary.POITaxonomy)
		expect(mapping?.externalID).toBe(POI_CATEGORY)

		// Reading the id back through the vocabulary's owner catches a mapping onto an identifier
		// the taxonomy does not carry, which would look exactly like a working one from here.
		const category = getPOICategory(String(POI_CATEGORY))

		expect(category?.id).toBe(POI_CATEGORY)
		expect(category?.hierarchy).toEqual(["health_and_medical", "pharmacy"])
	})

	it("refuses `activity affords establishment`", async () => {
		const document = structuredClone(await authoredDocument())
		const activity = document.concepts.find((concept) => concept.id === OBTAIN_MEDICATION)

		expect(activity).toBeDefined()

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

	it("compiles to the same bytes twice", async () => {
		const document = await authoredDocument()

		expect(serializeCompiledModel(compileGeographicModel(document))).toBe(
			serializeCompiledModel(compileGeographicModel(document))
		)
	})
})

describe("the committed artifact", () => {
	it("is what the authored records compile to", async () => {
		expect(
			await readCompiledGeographicModel(),
			`stale artifact — regenerate with: ${REGENERATE_ARTIFACT_COMMAND}`
		).toEqual(await compileAuthoredGeographicModel())
	})

	it("is byte-identical to a fresh compile once both are canonically serialized", async () => {
		expect(
			serializeCompiledModel(await readCompiledGeographicModel()),
			`stale artifact — regenerate with: ${REGENERATE_ARTIFACT_COMMAND}`
		).toBe(serializeCompiledModel(await compileAuthoredGeographicModel()))
	})

	it("carries the ancestry the record set states", async () => {
		const closure = new Map(
			(await readCompiledGeographicModel()).inheritanceClosure.map((entry) => [String(entry.concept), entry.ancestors])
		)

		expect(closure.get(String(PHARMACY))).toEqual(["establishment", "healthcare_facility", "place"])
		expect(closure.get(String(OBTAIN_MEDICATION))).toEqual(["activity"])

		// `drugstore` sits under `establishment` directly and deliberately not under `healthcare_facility`:
		// its external hierarchy puts it under `retail`, disjoint from `health_and_medical`,
		// and placing it there would give every later healthcare class a retail ancestor.
		expect(closure.get(String(DRUGSTORE))).toEqual(["establishment", "place"])
		expect(closure.get(String(DRUGSTORE))).not.toContain("healthcare_facility")
	})

	it("derives nothing, because no ancestor asserts anything", async () => {
		// An empty table here is the truthful answer rather than an unread one, since no ancestor of
		// `pharmacy` or `drugstore` asserts anything and `compile.test.ts` exercises the derivation itself.
		const model = await readCompiledGeographicModel()
		const everyAncestor = new Set(model.inheritanceClosure.flatMap((entry) => entry.ancestors))

		const ancestorsWithAssertions = model.concepts
			.filter((concept) => concept.assertions.length && everyAncestor.has(concept.id))
			.map((concept) => concept.id)

		expect(ancestorsWithAssertions).toEqual([])
		expect(model.derivedFacts).toEqual([])
		expect(model.observations).toEqual([])
	})
})

describe("the wave-1 records", () => {
	it("carries the `drugstore` concept the amendment admits, with provenance naming the measured gap", async () => {
		const concept = (await compileAuthoredGeographicModel()).concepts.find((entry) => entry.id === DRUGSTORE)

		expect(concept).toBeDefined()
		expect(concept?.kind).toBe("establishment")
		expect(concept?.isA).toEqual(["establishment"])
		expect(concept?.status).toBe("active")
		expect(concept?.provenance.source).toBe("mailwoman-curated")
		expect(concept?.provenance.sourceRecord).toContain("§4.1")
		expect(concept?.provenance.sourceVersion).toContain("2026-07-22.0")
		expect(concept?.provenance.authoredAt).toBe("2026-08-27")
	})

	it("scopes the drugstore affordance to the US, at the strength the evidence carries", async () => {
		const concept = (await compileAuthoredGeographicModel()).concepts.find((entry) => entry.id === DRUGSTORE)
		const assertion = concept?.assertions.find((entry) => entry.relation === AFFORDS)

		expect(assertion?.id).toBe("drugstore-affords-obtain-medication")
		expect(assertion?.target).toBe(OBTAIN_MEDICATION)

		// Not `necessary`: the attested material says a US drugstore characteristically dispenses,
		// and neither a locale-scoped synonym nor a row count is a census of dispensing.
		expect(assertion?.modality).toBe(Modality.StronglyExpected)

		// The one country a committed record scopes the class to; FR is a measured zero on
		// the shipped layer, so a claim reaching there would range over no rows.
		expect(assertion?.countries).toEqual(["US"])
		expect(assertion?.countries).not.toContain("FR")
		expect(assertion?.provenance.sourceRecord).toContain("curated-overlay.json")
	})

	it("maps it into the POI vocabulary, which is what makes the second afforded kind searchable", async () => {
		const model = await compileAuthoredGeographicModel()
		const mapping = model.mappings.find((entry) => entry.concept === DRUGSTORE)

		// The whole mapping table, so a mapping added anywhere trips this rather than only the two this test names.
		expect(model.mappings.map((entry) => entry.concept)).toEqual([DRUGSTORE, PHARMACY])
		expect(mapping?.id).toBe("poi-taxonomy-drugstore")
		expect(mapping?.vocabulary).toBe(ExternalVocabulary.POITaxonomy)
		expect(mapping?.externalID).toBe(DRUGSTORE_CATEGORY)
		expect(mapping?.provenance.source).toBe("mailwoman-curated")
		expect(mapping?.provenance.sourceRecord).toContain("taxonomy.json")

		// Reading the category back through the vocabulary's owner catches an identifier
		// that stopped resolving, which would leave the mapping translating into no category
		// and no other check would notice.
		const category = getPOICategory(String(DRUGSTORE_CATEGORY))

		expect(category?.id).toBe(DRUGSTORE_CATEGORY)
		expect(category?.hierarchy).toEqual(["retail", "drugstore"])

		// Disjoint from the pharmacy leaf, which is the whole reason the second mapping reaches rows the first cannot.
		expect(getPOICategory(String(POI_CATEGORY))?.hierarchy).toEqual(["health_and_medical", "pharmacy"])
	})
})

describe("reading the record set through the runtime lookups", () => {
	it("answers the proposition from the external category id, with provenance", async () => {
		const index = createGeographicModelIndex(await readCompiledGeographicModel())
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

	it("distinguishes a concept it carries from one it has never heard of", async () => {
		const index = createGeographicModelIndex(await readCompiledGeographicModel())

		expect(index.derivedFactsAbout(PHARMACY)).toEqual([])
		expect(index.derivedFactsAbout(toConceptID("chemist"))).toBeUndefined()
	})

	// `derivedFactsAbout` returning `[]` reads like an unmapped external lookup, so the empty answer is
	// asserted beside the non-empty ones that show the model carries the concept and translates its id.
	it("carries `drugstore`, translates its external identifier, and has derived nothing about it", async () => {
		const index = createGeographicModelIndex(await readCompiledGeographicModel())

		expect(index.concept(DRUGSTORE)).toBeDefined()
		expect(index.concept(DRUGSTORE)?.assertions).toHaveLength(1)
		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, DRUGSTORE_CATEGORY)).toEqual([DRUGSTORE])
		expect(index.derivedFactsAbout(DRUGSTORE)).toEqual([])
	})

	// Each external identifier translates into its own concept and not the other, since the mapping
	// table states which id names which class and no entry in it states a preference between the two.
	it("reaches two mapped kinds for one activity, each from its own external identifier", async () => {
		const index = createGeographicModelIndex(await readCompiledGeographicModel())

		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, POI_CATEGORY)).toEqual([PHARMACY])
		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, DRUGSTORE_CATEGORY)).toEqual([DRUGSTORE])

		const affording = [PHARMACY, DRUGSTORE].filter((id) =>
			index.concept(id)?.assertions.some((entry) => entry.relation === AFFORDS && entry.target === OBTAIN_MEDICATION)
		)

		expect(affording).toEqual([PHARMACY, DRUGSTORE])
	})
})
