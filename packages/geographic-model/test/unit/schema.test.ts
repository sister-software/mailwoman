/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The schema and its validator, exercised against the frozen first slice from the boundary record
 *   (`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md` §4): `pharmacy affords
 *   obtain_medication`, mapped onto the `@mailwoman/poi-taxonomy` `pharmacy` category.
 *
 *   The fixtures below are typed with the package's own record types on purpose. A document assembled
 *   through `ConceptRecord`, `RelationRecord`, and the brand helpers, and then accepted by the
 *   validator, is the evidence that the schema can STATE the slice — a plain JSON literal cast at the
 *   end would prove only that the validator accepts some object.
 *
 *   This file holds the whole suite rather than splitting by concern: the package contract forbids a
 *   relative import between test files, and a fixture copied into a second file is a fixture that
 *   drifts.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import {
	type ConceptID,
	ConceptKind,
	type ConceptRecord,
	ConceptStatus,
	DerivationInputKind,
	type DerivedFactRecord,
	ExternalVocabulary,
	type ExternalMappingRecord,
	formatValidationIssues,
	type GeographicModelDocument,
	GeographicModelValidationError,
	Modality,
	parseGeographicModelDocument,
	type RelationAssertion,
	type RelationRecord,
	RelationSemantics,
	type SourceObservationRecord,
	type SourceProvenance,
	toConceptID,
	toDerivedFactID,
	toMappingID,
	toObservationID,
	toRelationID,
	toRuleID,
	type ValidationIssue,
	ValidationIssueCode,
	validateGeographicModelDocument,
} from "@mailwoman/geographic-model"
import { toPOICategoryID } from "@mailwoman/poi-taxonomy/types"
import { describe, expect, it } from "vitest"

const curated: SourceProvenance = {
	source: "mailwoman-curated",
	sourceVersion: "0.1.0",
	authoredAt: "2026-08-26",
	notes: "The frozen first slice recorded in #1917.",
}

const affords: RelationRecord = {
	id: toRelationID("affords"),
	label: "affords",
	description: "A person can carry out the target activity at the asserting concept's premises.",
	domainKinds: [ConceptKind.Establishment],
	rangeKinds: [ConceptKind.Activity],
	transitive: false,
	symmetric: false,
	semantics: RelationSemantics.Defeasible,
}

const affordance: RelationAssertion = {
	id: toRuleID("pharmacy-affords-obtain-medication"),
	relation: affords.id,
	target: toConceptID("obtain_medication"),
	modality: Modality.StronglyExpected,
	countries: ["US", "GB", "FR", "CA", "MX"],
	provenance: curated,
}

const pharmacy: ConceptRecord = {
	id: toConceptID("pharmacy"),
	label: "Pharmacy",
	description: "Premises that dispense prescription medication.",
	kind: ConceptKind.Establishment,
	isA: [],
	assertions: [affordance],
	provenance: curated,
	status: ConceptStatus.Active,
}

const obtainMedication: ConceptRecord = {
	id: toConceptID("obtain_medication"),
	label: "Obtain medication",
	description: "A person collects or buys medication.",
	kind: ConceptKind.Activity,
	isA: [],
	assertions: [],
	provenance: curated,
	status: ConceptStatus.Active,
}

const pharmacyCategory: ExternalMappingRecord = {
	id: toMappingID("pharmacy-poi-taxonomy-pharmacy"),
	concept: pharmacy.id,
	vocabulary: ExternalVocabulary.POITaxonomy,
	externalID: toPOICategoryID("pharmacy"),
	provenance: {
		source: "poi-taxonomy",
		sourceRecord: "pharmacy",
		notes: "Declares no overtureCategories, so the probe identifier is the category identifier itself.",
	},
}

const observed: SourceObservationRecord = {
	id: toObservationID("curated-overlay-pharmacy-dispenses"),
	subject: pharmacy.id,
	relation: affords.id,
	object: obtainMedication.id,
	modality: Modality.Expected,
	countries: ["US"],
	provenance: {
		source: "poi-taxonomy",
		sourceRecord: "curated-overlay.json#pharmacy",
	},
}

const derived: DerivedFactRecord = {
	id: toDerivedFactID("pharmacy-obtain-medication-us"),
	derivation: "affordance-closure@1",
	inputs: [
		{ kind: DerivationInputKind.Relation, id: affords.id },
		{ kind: DerivationInputKind.Concept, id: obtainMedication.id },
		{ kind: DerivationInputKind.Assertion, id: affordance.id },
		{ kind: DerivationInputKind.Mapping, id: pharmacyCategory.id },
		{ kind: DerivationInputKind.Observation, id: observed.id },
	],
	subject: pharmacy.id,
	relation: affords.id,
	object: obtainMedication.id,
	modality: Modality.Expected,
	countries: ["US"],
}

/**
 * Concepts and the one relation, with every other table empty. The base for the refusal cases, so an expected issue
 * list stays short enough to state in full.
 */
const minimalSlice: GeographicModelDocument = {
	version: "0.1.0",
	relations: [affords],
	concepts: [pharmacy, obtainMedication],
	mappings: [],
	observations: [],
	derivedFacts: [],
}

/**
 * The whole first slice: the concepts, the mapping into the external vocabulary, one source observation, and one
 * derived fact naming every record its derivation read.
 */
const pharmacySlice: GeographicModelDocument = {
	...minimalSlice,
	mappings: [pharmacyCategory],
	observations: [observed],
	derivedFacts: [derived],
}

interface DraftDocument {
	version?: unknown
	relations: Array<Record<string, unknown>>
	concepts: Array<Record<string, unknown>>
	mappings: Array<Record<string, unknown>>
	observations: Array<Record<string, unknown>>
	derivedFacts: Array<Record<string, unknown>>
}

/**
 * A JSON round-trip of a fixture, loosely typed so a case can introduce exactly the defect it is about.
 */
function draft(base: GeographicModelDocument, mutate: (document: DraftDocument) => void): unknown {
	const document = parseJSONStrict<DraftDocument>(JSON.stringify(base))

	mutate(document)

	return document
}

function assertionsOf(concept: Record<string, unknown>): Array<Record<string, unknown>> {
	return concept.assertions as Array<Record<string, unknown>>
}

function refusalOf(input: unknown): ValidationIssue[] {
	const result = validateGeographicModelDocument(input)

	if (result.ok) throw new Error("expected the document to be refused, and it validated")

	return result.issues
}

/**
 * Every issue as a `path → code` pair, so a case can state the WHOLE expected list rather than the one entry it
 * remembered to look for.
 */
function refusalPairs(input: unknown): Array<[string, ValidationIssueCode]> {
	return refusalOf(input).map((issue) => [issue.path, issue.code])
}

describe("the concept vocabulary", () => {
	it("carries no kind beyond place, establishment, and activity", () => {
		expect(Object.values(ConceptKind)).toEqual(["place", "establishment", "activity"])
	})

	it("carries the eight recorded modality values and no numeric scale", () => {
		expect(Object.values(Modality)).toEqual([
			"necessary",
			"prohibited",
			"strongly_expected",
			"expected",
			"weakly_expected",
			"possible",
			"unusual",
			"strongly_unusual",
		])

		for (const modality of Object.values(Modality)) {
			expect(typeof modality).toBe("string")
		}
	})
})

describe("branded identifiers", () => {
	it("preserves the string at runtime", () => {
		expect(toConceptID("pharmacy")).toBe("pharmacy")
		expect(toRelationID("affords")).toBe("affords")
		expect(toRuleID("pharmacy-affords-obtain-medication")).toBe("pharmacy-affords-obtain-medication")
		expect(toMappingID("m1")).toBe("m1")
		expect(toObservationID("o1")).toBe("o1")
		expect(toDerivedFactID("d1")).toBe("d1")
		expect(JSON.stringify({ id: toConceptID("pharmacy") })).toBe('{"id":"pharmacy"}')
	})

	it("refuses a relation identifier where a concept identifier belongs", () => {
		const relationID = toRelationID("affords")
		// @ts-expect-error a RelationID is not a ConceptID; the brands exist to make this assignment fail.
		const conceptID: ConceptID = relationID

		expect(conceptID).toBe("affords")
	})

	it("refuses a plain string where a branded identifier belongs", () => {
		// @ts-expect-error an unbranded string is not a ConceptID; conversion goes through toConceptID.
		const conceptID: ConceptID = "pharmacy"

		expect(conceptID).toBe("pharmacy")
	})
})

describe("the frozen pharmacy slice", () => {
	it("is stateable through the record types and validates", () => {
		const result = validateGeographicModelDocument(pharmacySlice)

		expect(result.ok).toBe(true)

		const document = parseGeographicModelDocument(pharmacySlice)
		const [establishment] = document.concepts

		expect(establishment?.id).toBe("pharmacy")
		expect(establishment?.kind).toBe(ConceptKind.Establishment)

		expect(
			establishment?.assertions.map((assertion) => [assertion.relation, assertion.target, assertion.modality])
		).toEqual([["affords", "obtain_medication", "strongly_expected"]])

		expect(document.mappings.map((mapping) => [mapping.vocabulary, mapping.externalID])).toEqual([
			["poi-taxonomy", "pharmacy"],
		])
	})

	it("keeps source observations and derived facts in separate tables", () => {
		const document = parseGeographicModelDocument(pharmacySlice)

		expect(document.observations.map((observation) => observation.id)).toEqual(["curated-overlay-pharmacy-dispenses"])

		expect(document.derivedFacts.map((fact) => fact.derivation)).toEqual(["affordance-closure@1"])

		expect(document.derivedFacts[0]?.inputs.map((input) => input.kind)).toEqual([
			"relation",
			"concept",
			"assertion",
			"mapping",
			"observation",
		])
	})

	it("round-trips through JSON without losing a record", () => {
		const encoded = JSON.stringify(pharmacySlice)
		const document = parseGeographicModelDocument(parseJSONStrict<unknown>(encoded))

		expect(document).toEqual(pharmacySlice)
		expect(JSON.stringify(document)).toBe(encoded)
	})
})

describe("shape refusals", () => {
	it("refuses an unknown concept kind", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.kind = "shop"
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].kind", ValidationIssueCode.UnknownConceptKind]])
	})

	it("refuses an unknown modality", () => {
		const input = draft(minimalSlice, (document) => {
			assertionsOf(document.concepts[0]!)[0]!.modality = "very_likely"
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].assertions[0].modality", ValidationIssueCode.UnknownModality]])
	})

	it("refuses an unknown concept status and an unknown relation semantics", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.status = "provisional"
			document.relations[0]!.semantics = "probabilistic"
		})

		expect(refusalPairs(input)).toEqual([
			["$.relations[0].semantics", ValidationIssueCode.UnknownRelationSemantics],
			["$.concepts[0].status", ValidationIssueCode.UnknownConceptStatus],
		])
	})

	it("refuses a blank provenance source", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.provenance = { source: "   " }
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].provenance.source", ValidationIssueCode.EmptyValue]])
	})

	it("refuses a missing table rather than reading it as an empty one", () => {
		const input = draft(minimalSlice, (document) => {
			Reflect.deleteProperty(document, "derivedFacts")
		})

		expect(refusalPairs(input)).toEqual([["$.derivedFacts", ValidationIssueCode.MissingField]])
	})

	it("refuses a country scope that is not an upper-case ISO 3166-1 alpha-2 code", () => {
		const input = draft(minimalSlice, (document) => {
			assertionsOf(document.concepts[0]!)[0]!.countries = ["us", "USA"]
		})

		expect(refusalPairs(input)).toEqual([
			["$.concepts[0].assertions[0].countries[0]", ValidationIssueCode.MalformedCountry],
			["$.concepts[0].assertions[0].countries[1]", ValidationIssueCode.MalformedCountry],
		])
	})

	it("refuses a field the schema does not declare", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.synonyms = ["chemist"]
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].synonyms", ValidationIssueCode.UnknownField]])
	})
})

describe("ranking-policy refusals", () => {
	it("refuses every generic ranking field the program names, wherever it appears", () => {
		const input = draft(minimalSlice, (document) => {
			const assertion = assertionsOf(document.concepts[0]!)[0]!

			assertion.score = 0.9
			assertion.boost = 2
			assertion.penalty = -1
			assertion.rankWeight = 0.5
			assertion.relevanceWeight = 0.25
			assertion.affinityWeight = 0.75
			document.relations[0]!.priority = 1
		})

		expect(refusalPairs(input)).toEqual([
			["$.relations[0].priority", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].score", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].boost", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].penalty", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].rankWeight", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].relevanceWeight", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].affinityWeight", ValidationIssueCode.RankingField],
		])
	})

	it("names the ranking fragment it matched, so the message says why", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.affinityWeight = 1
		})

		expect(refusalOf(input)[0]?.message).toContain("weight")
	})
})

describe("whole-table refusals", () => {
	it("refuses a duplicate identifier and keeps the first claimant", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[1]!.id = "pharmacy"
		})

		expect(refusalPairs(input)).toEqual([
			["$.concepts[1].id", ValidationIssueCode.DuplicateID],
			["$.concepts[0].assertions[0].target", ValidationIssueCode.UnknownConcept],
		])
	})

	it("refuses a concept that is a kind of itself", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.isA = ["pharmacy"]
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].isA[0]", ValidationIssueCode.SelfReference]])
	})

	it("refuses an isA cycle that runs through more than one concept", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.isA = ["obtain_medication"]
			document.concepts[1]!.isA = ["pharmacy"]
		})

		expect(refusalPairs(input)).toEqual([
			["$.concepts[0].isA", ValidationIssueCode.CyclicIsA],
			["$.concepts[1].isA", ValidationIssueCode.CyclicIsA],
		])
	})

	it("refuses an isA parent no concept declares", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.isA = ["retail_premises"]
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].isA[0]", ValidationIssueCode.UnknownConcept]])
	})

	it("refuses an assertion naming a relation no document declares", () => {
		const input = draft(minimalSlice, (document) => {
			assertionsOf(document.concepts[0]!)[0]!.relation = "sells"
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].assertions[0].relation", ValidationIssueCode.UnknownRelation]])
	})

	it("refuses an assertion naming a target concept no document declares", () => {
		const input = draft(minimalSlice, (document) => {
			assertionsOf(document.concepts[0]!)[0]!.target = "collect_parcel"
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].assertions[0].target", ValidationIssueCode.UnknownConcept]])
	})

	it("refuses an assertion whose asserting concept is outside the relation's domain kinds", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[0]!.kind = ConceptKind.Activity
		})

		expect(refusalPairs(input)).toEqual([
			["$.concepts[0].assertions[0].relation", ValidationIssueCode.DomainKindMismatch],
		])
	})

	it("refuses an assertion whose target is outside the relation's range kinds", () => {
		const input = draft(minimalSlice, (document) => {
			document.concepts[1]!.kind = ConceptKind.Establishment
		})

		expect(refusalPairs(input)).toEqual([["$.concepts[0].assertions[0].target", ValidationIssueCode.RangeKindMismatch]])
	})

	it("refuses a mapping onto a concept no document declares", () => {
		const input = draft(pharmacySlice, (document) => {
			document.mappings[0]!.concept = "chemist"
		})

		expect(refusalPairs(input)).toEqual([["$.mappings[0].concept", ValidationIssueCode.UnknownConcept]])
	})
})

describe("relation refusals", () => {
	it("refuses an inverse no document declares", () => {
		const input = draft(minimalSlice, (document) => {
			document.relations[0]!.inverse = "afforded_by"
		})

		expect(refusalPairs(input)).toEqual([["$.relations[0].inverse", ValidationIssueCode.UnknownRelation]])
	})

	it("refuses an inverse that does not name this relation back", () => {
		const input = draft(minimalSlice, (document) => {
			document.relations[0]!.inverse = "afforded_by"

			document.relations.push({
				id: "afforded_by",
				label: "afforded by",
				description: "The target activity can be carried out at the subject's premises.",
				domainKinds: [ConceptKind.Activity],
				rangeKinds: [ConceptKind.Establishment],
				transitive: false,
				symmetric: false,
				semantics: RelationSemantics.Defeasible,
			})
		})

		expect(refusalPairs(input)).toEqual([["$.relations[0].inverse", ValidationIssueCode.InverseNotReciprocal]])
	})

	it("refuses both halves of an inverse pair whose domain and range kinds are not swapped", () => {
		const input = draft(minimalSlice, (document) => {
			document.relations[0]!.inverse = "afforded_by"

			document.relations.push({
				id: "afforded_by",
				label: "afforded by",
				description: "The target activity can be carried out at the subject's premises.",
				domainKinds: [ConceptKind.Activity],
				rangeKinds: [ConceptKind.Activity],
				transitive: false,
				symmetric: false,
				semantics: RelationSemantics.Defeasible,
				inverse: "affords",
			})
		})

		// Both records declare the pairing, so both are named. Either one could be the half that is wrong, and the
		// validator does not get to decide which.
		expect(refusalPairs(input)).toEqual([
			["$.relations[0].inverse", ValidationIssueCode.InverseKindsMismatch],
			["$.relations[1].inverse", ValidationIssueCode.InverseKindsMismatch],
		])
	})

	it("refuses a transitive relation whose domain and range kinds cannot chain", () => {
		const input = draft(minimalSlice, (document) => {
			document.relations[0]!.transitive = true
		})

		expect(refusalPairs(input)).toEqual([["$.relations[0].transitive", ValidationIssueCode.TransitiveKindsDisjoint]])
	})
})

describe("derived-fact refusals", () => {
	it("refuses a derived fact with no inputs", () => {
		const input = draft(pharmacySlice, (document) => {
			document.derivedFacts[0]!.inputs = []
		})

		expect(refusalPairs(input)).toEqual([["$.derivedFacts[0].inputs", ValidationIssueCode.EmptyList]])
	})

	it("refuses an input that resolves against no record of its kind", () => {
		const input = draft(pharmacySlice, (document) => {
			document.derivedFacts[0]!.inputs = [{ kind: DerivationInputKind.Observation, id: "affords" }]
		})

		expect(refusalPairs(input)).toEqual([
			["$.derivedFacts[0].inputs[0].id", ValidationIssueCode.UnknownDerivationInput],
		])
	})

	it("refuses a derived fact that names itself as an input", () => {
		const input = draft(pharmacySlice, (document) => {
			document.derivedFacts[0]!.inputs = [
				{ kind: DerivationInputKind.DerivedFact, id: "pharmacy-obtain-medication-us" },
			]
		})

		expect(refusalPairs(input)).toEqual([["$.derivedFacts[0].inputs[0].id", ValidationIssueCode.SelfReference]])
	})

	it("refuses an unknown derivation input kind", () => {
		const input = draft(pharmacySlice, (document) => {
			document.derivedFacts[0]!.inputs = [{ kind: "layer", id: "poi" }]
		})

		expect(refusalPairs(input)).toEqual([
			["$.derivedFacts[0].inputs[0].kind", ValidationIssueCode.UnknownDerivationInputKind],
		])
	})
})

describe("reporting every violation at once", () => {
	/**
	 * Nine independent defects across four records and both passes. The whole list is stated, because a validator that
	 * reports the first violation and stops is the behavior this suite exists to refuse.
	 */
	function ninefoldDefect(): unknown {
		return draft(pharmacySlice, (document) => {
			document.version = ""
			document.concepts[0]!.kind = "shop"
			document.concepts[0]!.isA = ["pharmacy"]

			const assertion = assertionsOf(document.concepts[0]!)[0]!

			assertion.relation = "sells"
			assertion.modality = "very_likely"
			assertion.provenance = { source: "" }
			assertion.relevanceWeight = 0.5
			document.concepts[1]!.id = "pharmacy"
			document.mappings[0]!.vocabulary = "wikidata"
		})
	}

	it("reports every violation, each with the path it was found at", () => {
		expect(refusalPairs(ninefoldDefect())).toEqual([
			["$.version", ValidationIssueCode.EmptyValue],
			["$.concepts[0].kind", ValidationIssueCode.UnknownConceptKind],
			["$.concepts[0].assertions[0].relevanceWeight", ValidationIssueCode.RankingField],
			["$.concepts[0].assertions[0].modality", ValidationIssueCode.UnknownModality],
			["$.concepts[0].assertions[0].provenance.source", ValidationIssueCode.EmptyValue],
			["$.mappings[0].vocabulary", ValidationIssueCode.UnknownExternalVocabulary],
			["$.concepts[1].id", ValidationIssueCode.DuplicateID],
			["$.concepts[0].isA[0]", ValidationIssueCode.SelfReference],
			["$.concepts[0].assertions[0].relation", ValidationIssueCode.UnknownRelation],
			["$.concepts[0].assertions[0].target", ValidationIssueCode.UnknownConcept],
			// The duplicate identifier took `obtain_medication` out of the concept table, so every record that named it
			// now names nothing. That cascade is the reason the reference pass runs over whole tables.
			["$.observations[0].object", ValidationIssueCode.UnknownConcept],
			["$.derivedFacts[0].object", ValidationIssueCode.UnknownConcept],
			["$.derivedFacts[0].inputs[1].id", ValidationIssueCode.UnknownDerivationInput],
		])
	})

	it("produces the same list on a second run", () => {
		expect(refusalPairs(ninefoldDefect())).toEqual(refusalPairs(ninefoldDefect()))
	})

	it("returns no partial document when anything is wrong", () => {
		const result = validateGeographicModelDocument(ninefoldDefect())

		expect(result.ok).toBe(false)
		expect(Reflect.has(result, "document")).toBe(false)
	})

	it("throws every violation from the parsing form, in the message and on the error", () => {
		const input = ninefoldDefect()
		const issues = refusalOf(input)

		expect(() => parseGeographicModelDocument(input)).toThrow(GeographicModelValidationError)

		try {
			parseGeographicModelDocument(input)
		} catch (error) {
			expect(error).toBeInstanceOf(GeographicModelValidationError)

			const thrown = error as GeographicModelValidationError

			expect(thrown.issues).toHaveLength(issues.length)
			expect(thrown.message).toContain(`${issues.length} issues`)

			for (const issue of issues) {
				expect(thrown.message).toContain(`${issue.path}: ${issue.message} [${issue.code}]`)
			}
		}
	})

	it("refuses a document that is not an object at all", () => {
		expect(refusalPairs("pharmacy affords obtain_medication")).toEqual([["$", ValidationIssueCode.WrongType]])
		expect(refusalPairs([pharmacySlice])).toEqual([["$", ValidationIssueCode.WrongType]])
	})

	it("renders one line per issue", () => {
		const issues = refusalOf(ninefoldDefect())
		const rendered = formatValidationIssues(issues)

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- an in-memory string of one line per issue, and the line count IS the assertion.
		expect(rendered.split("\n")).toHaveLength(issues.length)
	})
})
