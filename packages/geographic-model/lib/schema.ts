/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines the authored record schema for `@mailwoman/geographic-model`: identifiers, closed
 *   vocabularies and the shapes of concepts, relations, mappings, observations and derived facts.
 *
 *   The schema has no numeric fields. {@link Modality} is a vocabulary of words with no exported order,
 *   because ranking weights belong to `@mailwoman/resolver` and `@mailwoman/neural`.
 *
 *   Authored assertions, source observations and derived facts are separate types with separately
 *   branded identifiers. A derived fact has no {@link SourceProvenance}. Its `derivation` and `inputs`
 *   serve as its provenance.
 *
 *   Each table has its own identifier namespace, so a {@link ConceptID} and a {@link RelationID} may hold
 *   the same string.
 */

import type { POICategoryID } from "@mailwoman/poi-taxonomy/types"
import type { Tagged } from "type-fest"

/**
 * A branded concept identifier, such as `pharmacy` or `obtain_medication`.
 */
export type ConceptID = Tagged<string, "GeographicConceptID">

/**
 * Brands a string as a {@link ConceptID} without changing it.
 */
export function toConceptID(id: string): ConceptID {
	return id as ConceptID
}

/**
 * A branded relation identifier, such as `affords`.
 */
export type RelationID = Tagged<string, "GeographicRelationID">

/**
 * Brands a string as a {@link RelationID} without changing it.
 */
export function toRelationID(id: string): RelationID {
	return id as RelationID
}

/**
 * The branded identifier of one {@link RelationAssertion}.
 */
export type RuleID = Tagged<string, "GeographicRuleID">

/**
 * Brands a string as a {@link RuleID} without changing it.
 */
export function toRuleID(id: string): RuleID {
	return id as RuleID
}

/**
 * The branded identifier of one {@link ExternalMappingRecord}.
 */
export type MappingID = Tagged<string, "GeographicMappingID">

/**
 * Brands a string as a {@link MappingID} without changing it.
 */
export function toMappingID(id: string): MappingID {
	return id as MappingID
}

/**
 * The branded identifier of one {@link SourceObservationRecord}.
 */
export type ObservationID = Tagged<string, "GeographicObservationID">

/**
 * Brands a string as an {@link ObservationID} without changing it.
 */
export function toObservationID(id: string): ObservationID {
	return id as ObservationID
}

/**
 * The branded identifier of one {@link DerivedFactRecord}.
 */
export type DerivedFactID = Tagged<string, "GeographicDerivedFactID">

/**
 * Brands a string as a {@link DerivedFactID} without changing it.
 */
export function toDerivedFactID(id: string): DerivedFactID {
	return id as DerivedFactID
}

/**
 * The concept kinds.
 * Adding a kind requires a reviewed schema revision.
 */
export const ConceptKind = {
	/**
	 * A geographic area or point where other things are located.
	 */
	Place: "place",
	/**
	 * A class of premises that a person can visit, such as `pharmacy`.
	 */
	Establishment: "establishment",
	/**
	 * Something a person does, such as `obtain_medication`.
	 */
	Activity: "activity",
} as const

/**
 * A {@link ConceptKind} value.
 */
export type ConceptKind = (typeof ConceptKind)[keyof typeof ConceptKind]

/**
 * How strongly an assertion, observation or derived fact claims that its proposition holds.
 *
 * The values are ordinal in meaning, but the module exports no order
 * so that nobody converts them into weights.
 */
export const Modality = {
	/**
	 * Holds in every instance.
	 * A counterexample falsifies the record.
	 */
	Necessary: "necessary",
	/**
	 * Never holds.
	 */
	Prohibited: "prohibited",
	StronglyExpected: "strongly_expected",
	Expected: "expected",
	WeaklyExpected: "weakly_expected",
	/**
	 * Consistent with the concept, with no claim about frequency.
	 */
	Possible: "possible",
	Unusual: "unusual",
	StronglyUnusual: "strongly_unusual",
} as const

/**
 * A {@link Modality} value.
 */
export type Modality = (typeof Modality)[keyof typeof Modality]

/**
 * Whether a relation's assertions admit exceptions.
 */
export const RelationSemantics = {
	/**
	 * An exception is a defect in the record set.
	 */
	Hard: "hard",
	/**
	 * An exception is expected and does not falsify the relation.
	 */
	Defeasible: "defeasible",
} as const

/**
 * A {@link RelationSemantics} value.
 */
export type RelationSemantics = (typeof RelationSemantics)[keyof typeof RelationSemantics]

/**
 * A concept's review status, which tells consumers whether to use the record.
 */
export const ConceptStatus = {
	/**
	 * Authored but not yet reviewed.
	 */
	Draft: "draft",
	Active: "active",
	/**
	 * Retained so that existing references resolve.
	 * New references should avoid it.
	 */
	Deprecated: "deprecated",
} as const

/**
 * A {@link ConceptStatus} value.
 */
export type ConceptStatus = (typeof ConceptStatus)[keyof typeof ConceptStatus]

/**
 * External vocabularies that concepts can map to.
 *
 * {@link ExternalMappingRecord} assumes a single vocabulary.
 * A second vocabulary would require a union discriminated on `vocabulary`.
 */
export const ExternalVocabulary = {
	/**
	 * Category identifiers from `@mailwoman/poi-taxonomy`.
	 */
	POITaxonomy: "poi-taxonomy",
} as const

/**
 * An {@link ExternalVocabulary} value.
 */
export type ExternalVocabulary = (typeof ExternalVocabulary)[keyof typeof ExternalVocabulary]

/**
 * The origin of a record.
 * `source` must be non-empty.
 */
export interface SourceProvenance {
	/**
	 * The authority, dataset, publication or curator, such as `overture-places` or `mailwoman-curated`.
	 */
	source: string
	/**
	 * The source's version or release string, such as an Overture release.
	 */
	sourceVersion?: string
	/**
	 * The identifier of the specific source record that supports the claim.
	 */
	sourceRecord?: string
	sourceURL?: string
	/**
	 * ISO 8601 date on which the record was authored, as `YYYY-MM-DD`.
	 */
	authoredAt?: string
	notes?: string
}

/**
 * One relation's definition.
 *
 * A relation record defines meaning and the concept kinds allowed on each side.
 * It makes no claim about any particular pair.
 */
export interface RelationRecord {
	id: RelationID
	label: string
	description: string
	/**
	 * The concept kinds allowed on the asserting side.
	 */
	domainKinds: ConceptKind[]
	/**
	 * The concept kinds allowed on the target side.
	 */
	rangeKinds: ConceptKind[]
	transitive: boolean
	symmetric: boolean
	/**
	 * The relation that reads the same edge in the opposite direction.
	 *
	 * When set, it must exist and declare this relation as its own inverse.
	 */
	inverse?: RelationID
	semantics: RelationSemantics
}

/**
 * One curated claim, stored on the concept that it describes.
 */
export interface RelationAssertion {
	id: RuleID
	relation: RelationID
	target: ConceptID
	modality: Modality
	/**
	 * ISO 3166-1 alpha-2 codes that scope the claim.
	 *
	 * An absent list means the claim has no country scope, which is weaker than a claim about every country.
	 */
	countries?: string[]
	provenance: SourceProvenance
}

/**
 * One concept and its authored assertions.
 */
export interface ConceptRecord {
	id: ConceptID
	label: string
	description: string
	kind: ConceptKind
	/**
	 * Broader concepts that this concept is a kind of.
	 * The list may be empty but must not form a cycle.
	 */
	isA: ConceptID[]
	assertions: RelationAssertion[]
	provenance: SourceProvenance
	status: ConceptStatus
}

/**
 * Maps an external vocabulary identifier to a concept.
 * The mapping adds no semantics.
 */
export interface ExternalMappingRecord {
	id: MappingID
	concept: ConceptID
	vocabulary: ExternalVocabulary
	/**
	 * The identifier in the external vocabulary.
	 *
	 * The type is `POICategoryID` because `poi-taxonomy` is the only external vocabulary.
	 */
	externalID: POICategoryID
	provenance: SourceProvenance
}

/**
 * A proposition stated by a named external source, expressed in this model's vocabulary.
 *
 * Observations stay out of the concept table.
 * Turning one into an authored assertion requires an explicit curation decision with its own provenance.
 */
export interface SourceObservationRecord {
	id: ObservationID
	subject: ConceptID
	relation: RelationID
	object: ConceptID
	modality: Modality
	/**
	 * ISO 3166-1 alpha-2 codes that scope the source's statement.
	 */
	countries?: string[]
	provenance: SourceProvenance
}

/**
 * The table that a {@link DerivationInput} refers to.
 */
export const DerivationInputKind = {
	Concept: "concept",
	Relation: "relation",
	Assertion: "assertion",
	Mapping: "mapping",
	Observation: "observation",
	DerivedFact: "derived_fact",
} as const

/**
 * A {@link DerivationInputKind} value.
 */
export type DerivationInputKind = (typeof DerivationInputKind)[keyof typeof DerivationInputKind]

/**
 * One record that a derivation read.
 * The `kind` discriminant fixes the identifier's brand.
 */
export type DerivationInput =
	| { kind: typeof DerivationInputKind.Concept; id: ConceptID }
	| { kind: typeof DerivationInputKind.Relation; id: RelationID }
	| { kind: typeof DerivationInputKind.Assertion; id: RuleID }
	| { kind: typeof DerivationInputKind.Mapping; id: MappingID }
	| { kind: typeof DerivationInputKind.Observation; id: ObservationID }
	| { kind: typeof DerivationInputKind.DerivedFact; id: DerivedFactID }

/**
 * A fact that a named procedure computed from specific input records.
 *
 * The record has no provenance field.
 * Its `derivation` and `inputs` serve as provenance, and the validator rejects
 * a fact whose inputs do not resolve.
 */
export interface DerivedFactRecord {
	id: DerivedFactID
	/**
	 * The name of the deterministic procedure that produced this fact.
	 */
	derivation: string
	/**
	 * Every record that the derivation read.
	 * The list must be non-empty and every input must resolve.
	 */
	inputs: DerivationInput[]
	subject: ConceptID
	relation: RelationID
	object: ConceptID
	modality: Modality
	countries?: string[]
}

/**
 * One complete authored document.
 *
 * Every field is required, including `derivedFacts`, so that a dropped table fails
 * validation instead of reading as an empty one.
 */
export interface GeographicModelDocument {
	/**
	 * The document's data version.
	 */
	version: string
	relations: RelationRecord[]
	concepts: ConceptRecord[]
	mappings: ExternalMappingRecord[]
	observations: SourceObservationRecord[]
	derivedFacts: DerivedFactRecord[]
}
