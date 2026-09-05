/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The compiler, its derivations, and the two determinism properties the artifact is a contract for:
 *   the same document compiles to the same bytes, and a document whose tables and object keys are
 *   permuted compiles to the SAME bytes as the unpermuted one.
 *
 *   The fixture extends the frozen first slice (`pharmacy affords obtain_medication`) with the
 *   inheritance shapes a closure has to get right and one slice cannot exercise: a chain
 *   (`hospital_pharmacy` → `pharmacy` → `retailer`), a diamond (`late_night_pharmacy` reaching
 *   `retailer` by two routes), two ancestors stating one proposition (`corner_shop`), and a
 *   descendant that speaks for itself (`veterinary_pharmacy`).
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import {
	ARTIFACT_SCHEMA_VERSION,
	type CompiledGeographicModel,
	compileGeographicModel,
	CompileIssueCode,
	type ConceptID,
	ConceptKind,
	type ConceptRecord,
	ConceptStatus,
	createGeographicModelIndex,
	DerivationInputKind,
	DERIVATION_ISA_INHERITANCE,
	type DerivedFactRecord,
	type ExternalMappingRecord,
	ExternalVocabulary,
	GeographicModelArtifactError,
	GeographicModelCompileError,
	type GeographicModelDocument,
	GeographicModelValidationError,
	Modality,
	parseCompiledGeographicModel,
	type RelationAssertion,
	type RelationRecord,
	RelationSemantics,
	serializeCompiledModel,
	type SourceObservationRecord,
	type SourceProvenance,
	toConceptID,
	toDerivedFactID,
	toMappingID,
	toObservationID,
	toRelationID,
	toRuleID,
	ValidationIssueCode,
} from "@mailwoman/geographic-model"
import { toPOICategoryID } from "@mailwoman/poi-taxonomy/types"
import { describe, expect, it } from "vitest"

const curated: SourceProvenance = {
	source: "mailwoman-curated",
	authoredAt: "2026-08-26",
}

const affords: RelationRecord = {
	id: toRelationID("affords"),
	label: "affords",
	description: "The establishment class makes the activity available to a person who goes there.",
	domainKinds: [ConceptKind.Establishment],
	rangeKinds: [ConceptKind.Activity],
	transitive: false,
	symmetric: false,
	semantics: RelationSemantics.Defeasible,
}

function activity(id: string, label: string): ConceptRecord {
	return {
		id: toConceptID(id),
		label,
		description: `The activity of ${label}.`,
		kind: ConceptKind.Activity,
		isA: [],
		assertions: [],
		provenance: curated,
		status: ConceptStatus.Active,
	}
}

function affordance(id: string, target: string, modality: Modality): RelationAssertion {
	return {
		id: toRuleID(id),
		relation: affords.id,
		target: toConceptID(target),
		modality,
		provenance: curated,
	}
}

function establishment(
	id: string,
	isA: readonly string[],
	assertions: readonly RelationAssertion[] = []
): ConceptRecord {
	return {
		id: toConceptID(id),
		label: id.replaceAll("_", " "),
		description: `Premises of the ${id.replaceAll("_", " ")} kind.`,
		kind: ConceptKind.Establishment,
		isA: isA.map(toConceptID),
		assertions: [...assertions],
		provenance: curated,
		status: ConceptStatus.Active,
	}
}

const obtainMedication = activity("obtain_medication", "obtaining medication")
const purchaseGoods = activity("purchase_goods", "purchasing goods")

const retailer = establishment(
	"retailer",
	[],
	[affordance("assert-retailer-purchase", "purchase_goods", Modality.Expected)]
)

const generalStore = establishment(
	"general_store",
	[],
	[affordance("assert-general-store-purchase", "purchase_goods", Modality.Expected)]
)

const pharmacy = establishment(
	"pharmacy",
	["retailer"],
	[affordance("assert-pharmacy-medication", "obtain_medication", Modality.Necessary)]
)

const hospitalPharmacy = establishment("hospital_pharmacy", ["pharmacy"])
const lateNightPharmacy = establishment("late_night_pharmacy", ["pharmacy", "retailer"])
const cornerShop = establishment("corner_shop", ["retailer", "general_store"])

/**
 * A descendant that states the inherited proposition itself, under a weaker modality. The authored record is the more
 * specific one, so nothing is derived for that pair.
 */
const veterinaryPharmacy = establishment(
	"veterinary_pharmacy",
	["pharmacy"],
	[affordance("assert-veterinary-medication", "obtain_medication", Modality.Unusual)]
)

const pharmacyMapping: ExternalMappingRecord = {
	id: toMappingID("map-poi-pharmacy"),
	concept: pharmacy.id,
	vocabulary: ExternalVocabulary.POITaxonomy,
	externalID: toPOICategoryID("pharmacy"),
	provenance: curated,
}

const observed: SourceObservationRecord = {
	id: toObservationID("obs-pharmacy-medication"),
	subject: pharmacy.id,
	relation: affords.id,
	object: obtainMedication.id,
	modality: Modality.StronglyExpected,
	provenance: { source: "overture-places", sourceVersion: "2026-07-22.0" },
}

function slice(): GeographicModelDocument {
	return {
		version: "0.1.0",
		relations: [affords],
		concepts: [
			obtainMedication,
			purchaseGoods,
			retailer,
			generalStore,
			pharmacy,
			hospitalPharmacy,
			lateNightPharmacy,
			cornerShop,
			veterinaryPharmacy,
		],
		mappings: [pharmacyMapping],
		observations: [observed],
		derivedFacts: [],
	}
}

/**
 * Rebuild a value with every object's keys in the opposite order, at every depth. Arrays keep their order — the caller
 * reverses the tables it wants reversed, and an assertion list is authored order the compiler is supposed to preserve.
 */
function withReversedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withReversedKeys)

	if (typeof value !== "object" || value === null) return value

	return Object.fromEntries(
		Object.entries(value)
			.toReversed()
			.map(([key, entry]) => [key, withReversedKeys(entry)])
	)
}

/**
 * The same document, authored in the opposite order everywhere an order is not meaningful.
 */
function permuted(document: GeographicModelDocument): unknown {
	return withReversedKeys({
		...document,
		relations: document.relations.toReversed(),
		concepts: document.concepts.toReversed(),
		mappings: document.mappings.toReversed(),
		observations: document.observations.toReversed(),
		derivedFacts: document.derivedFacts.toReversed(),
	})
}

function ancestorsIn(model: CompiledGeographicModel, concept: string): readonly ConceptID[] | undefined {
	return model.inheritanceClosure.find((entry) => entry.concept === concept)?.ancestors
}

function factsAbout(model: CompiledGeographicModel, concept: string): DerivedFactRecord[] {
	return model.derivedFacts.filter((fact) => fact.subject === concept)
}

describe("the inheritance closure", () => {
	it("is transitive, deduplicated, and carries an entry for every concept", () => {
		const model = compileGeographicModel(slice())

		expect(model.inheritanceClosure.map((entry) => entry.concept)).toEqual(model.concepts.map((concept) => concept.id))

		// A chain: two links up through `pharmacy`.
		expect(ancestorsIn(model, "hospital_pharmacy")).toEqual(["pharmacy", "retailer"])

		// A diamond: `retailer` is reachable directly and through `pharmacy`, and appears once.
		expect(ancestorsIn(model, "late_night_pharmacy")).toEqual(["pharmacy", "retailer"])

		// A concept that is a kind of nothing gets an entry stating that, not an absent entry.
		expect(ancestorsIn(model, "retailer")).toEqual([])
		expect(ancestorsIn(model, "obtain_medication")).toEqual([])
	})

	it("leaves the authored document untouched", () => {
		const document = slice()
		const before = JSON.stringify(document)

		compileGeographicModel(document)

		expect(JSON.stringify(document)).toBe(before)
	})
})

describe("derived facts", () => {
	it("materializes every ancestor's assertions onto its descendants", () => {
		const model = compileGeographicModel(slice())
		const inherited = factsAbout(model, "hospital_pharmacy")

		expect(inherited.map((fact) => [fact.relation, fact.object, fact.modality])).toEqual([
			["affords", "obtain_medication", Modality.Necessary],
			["affords", "purchase_goods", Modality.Expected],
		])

		expect(inherited.every((fact) => fact.derivation === DERIVATION_ISA_INHERITANCE)).toBe(true)
	})

	it("names every record the derivation read", () => {
		const model = compileGeographicModel(slice())
		const [fact] = factsAbout(model, "hospital_pharmacy")

		expect(fact?.inputs).toEqual([
			{ kind: DerivationInputKind.Concept, id: "hospital_pharmacy" },
			{ kind: DerivationInputKind.Concept, id: "pharmacy" },
			{ kind: DerivationInputKind.Relation, id: "affords" },
			{ kind: DerivationInputKind.Assertion, id: "assert-pharmacy-medication" },
		])
	})

	it("states one proposition once, naming every ancestor that supports it", () => {
		const model = compileGeographicModel(slice())
		const facts = factsAbout(model, "corner_shop")

		expect(facts).toHaveLength(1)

		expect(facts[0]?.inputs).toEqual([
			{ kind: DerivationInputKind.Concept, id: "corner_shop" },
			{ kind: DerivationInputKind.Concept, id: "general_store" },
			{ kind: DerivationInputKind.Concept, id: "retailer" },
			{ kind: DerivationInputKind.Relation, id: "affords" },
			{ kind: DerivationInputKind.Assertion, id: "assert-general-store-purchase" },
			{ kind: DerivationInputKind.Assertion, id: "assert-retailer-purchase" },
		])
	})

	it("derives nothing for a pair the descendant states itself", () => {
		const model = compileGeographicModel(slice())
		const facts = factsAbout(model, "veterinary_pharmacy")

		// The authored `unusual` assertion stands alone; only the unrelated inherited pair is materialized.
		expect(facts.map((fact) => fact.object)).toEqual(["purchase_goods"])
	})

	it("refuses to write a fact whose subject the relation does not accept", () => {
		const document = slice()

		document.concepts.push({
			...establishment("pharmacy_district", ["pharmacy"]),
			kind: ConceptKind.Place,
		})

		try {
			compileGeographicModel(document)
			expect.unreachable("a place inheriting an establishment's affordance must not compile")
		} catch (error) {
			expect(error).toBeInstanceOf(GeographicModelCompileError)

			expect((error as GeographicModelCompileError).issues.map((issue) => issue.code)).toContain(
				CompileIssueCode.InheritedDomainKindMismatch
			)

			expect((error as GeographicModelCompileError).message).toContain("pharmacy_district")
		}
	})

	it("refuses two derived facts claiming one identifier", () => {
		const document = slice()

		document.derivedFacts.push({
			id: toDerivedFactID(`${DERIVATION_ISA_INHERITANCE}:hospital_pharmacy:affords:obtain_medication:necessary`),
			derivation: "hand-authored",
			inputs: [{ kind: DerivationInputKind.Concept, id: pharmacy.id }],
			subject: hospitalPharmacy.id,
			relation: affords.id,
			object: obtainMedication.id,
			modality: Modality.Necessary,
		})

		try {
			compileGeographicModel(document)
			expect.unreachable("an authored fact taking a derived identifier must not compile")
		} catch (error) {
			expect(error).toBeInstanceOf(GeographicModelCompileError)

			expect((error as GeographicModelCompileError).issues.map((issue) => issue.code)).toEqual([
				CompileIssueCode.DuplicateDerivedFactID,
			])
		}
	})
})

describe("compilation refuses what the validator refuses", () => {
	function cyclic(): unknown {
		return {
			version: "0.1.0",
			relations: [],
			concepts: [establishment("alpha", ["beta"]), establishment("beta", ["alpha"])],
			mappings: [],
			observations: [],
			derivedFacts: [],
		}
	}

	it("names the trail an indirect `isA` cycle follows", () => {
		try {
			compileGeographicModel(cyclic())
			expect.unreachable("a cyclic document must not compile")
		} catch (error) {
			expect(error).toBeInstanceOf(GeographicModelValidationError)

			const issues = (error as GeographicModelValidationError).issues

			expect(issues.map((issue) => issue.code)).toEqual([ValidationIssueCode.CyclicIsA, ValidationIssueCode.CyclicIsA])

			expect(issues.map((issue) => issue.message)).toEqual([
				"`isA` cycles through alpha → beta → alpha",
				"`isA` cycles through beta → alpha → beta",
			])
		}
	})

	it("refuses a concept that is a kind of itself", () => {
		const document = slice()

		document.concepts.push(establishment("mail_room", ["mail_room"]))

		expect(() => compileGeographicModel(document)).toThrow(GeographicModelValidationError)
	})

	it("admits acyclic multiple inheritance", () => {
		expect(() => compileGeographicModel(slice())).not.toThrow()
	})
})

describe("the artifact's bytes", () => {
	function compiledBytes(document: unknown): string {
		const model = compileGeographicModel(document)

		return serializeCompiledModel(model)
	}

	it("are identical for two compiles of one document", () => {
		expect(compiledBytes(slice())).toBe(compiledBytes(slice()))
	})

	it("are identical for a document whose tables and keys are permuted", () => {
		// Without this the test would pass on two identical inputs and prove nothing about ordering.
		expect(JSON.stringify(permuted(slice()))).not.toBe(JSON.stringify(slice()))

		expect(compiledBytes(permuted(slice()))).toBe(compiledBytes(slice()))
	})

	it("carry the authored version and no compilation clock", () => {
		const bytes = compiledBytes(slice())

		expect(bytes).toContain(`"modelVersion": "0.1.0"`)
		expect(bytes).toContain(`"schemaVersion": ${ARTIFACT_SCHEMA_VERSION}`)
		expect(bytes.endsWith("\n")).toBe(true)
	})

	it("emit every object's keys in code-point order", () => {
		const model = compileGeographicModel(slice())
		const bytes = serializeCompiledModel(model)
		const roundTripped = parseCompiledGeographicModel(parseJSONStrict(bytes))

		expect(Object.keys(roundTripped)).toEqual(Object.keys(roundTripped).toSorted())
		expect(roundTripped).toEqual(model)
	})
})

describe("the artifact reader", () => {
	it("refuses an artifact written against another format version", () => {
		const model = compileGeographicModel(slice())

		expect(() => parseCompiledGeographicModel({ ...model, schemaVersion: ARTIFACT_SCHEMA_VERSION + 1 })).toThrow(
			GeographicModelArtifactError
		)
	})

	it("refuses an artifact missing a table rather than reading it as empty", () => {
		const { derivedFacts: _derivedFacts, ...withoutFacts } = compileGeographicModel(slice())

		expect(() => parseCompiledGeographicModel(withoutFacts)).toThrow(/derivedFacts/)
	})
})

describe("the read surface", () => {
	it("answers by lookup, and tells an unknown concept apart from a silent one", () => {
		const index = createGeographicModelIndex(compileGeographicModel(slice()))

		expect(index.concept(toConceptID("pharmacy"))?.label).toBe("pharmacy")
		expect(index.relation(toRelationID("affords"))?.semantics).toBe(RelationSemantics.Defeasible)
		expect(index.ancestorsOf(toConceptID("hospital_pharmacy"))).toEqual(["pharmacy", "retailer"])

		// Known, and a kind of nothing.
		expect(index.ancestorsOf(toConceptID("retailer"))).toEqual([])
		// Not in the artifact at all.
		expect(index.ancestorsOf(toConceptID("chemist"))).toBeUndefined()

		expect(index.derivedFactsAbout(toConceptID("retailer"))).toEqual([])
		expect(index.derivedFactsAbout(toConceptID("chemist"))).toBeUndefined()
	})

	it("translates an external identifier into the concepts mapped from it", () => {
		const index = createGeographicModelIndex(compileGeographicModel(slice()))

		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, toPOICategoryID("pharmacy"))).toEqual([
			"pharmacy",
		])

		expect(index.conceptsForExternalID(ExternalVocabulary.POITaxonomy, toPOICategoryID("drugstore"))).toEqual([])
	})
})
