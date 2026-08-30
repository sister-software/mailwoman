/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authored-record schema for `@mailwoman/geographic-model`: the stable identifiers, the closed
 *   vocabularies, and the record shapes for concepts, relations, external-vocabulary mappings, source
 *   observations, and derived facts.
 *
 *   Three properties hold by construction, and they are why the file reads the way it does.
 *
 *   **No numeric field exists anywhere in this schema** — not a strength, not a confidence, not a
 *   count. {@link Modality} is an ordinal vocabulary of WORDS and this module exports no order over
 *   it, because a number attached to an authored relationship is a ranking weight whatever it is
 *   called, and ranking belongs to `@mailwoman/resolver` and `@mailwoman/neural`.
 *
 *   **An authored assertion, a source observation, and a derived fact are three different types.** A
 *   {@link RelationAssertion} is authored by a curator and lives on the concept it is about; a
 *   {@link SourceObservationRecord} records what a named external source states and never enters the
 *   concept table; a {@link DerivedFactRecord} names the procedure that produced it and every input
 *   that procedure read. Their identifiers are separately branded, so one is not assignable where
 *   another is expected.
 *
 *   **Every record carries provenance, and a derived fact carries it structurally.** A derived fact
 *   has no {@link SourceProvenance} of its own: its `derivation` plus its resolved `inputs` ARE its
 *   provenance, and each input carries source provenance in turn.
 *
 *   Identifier namespaces are per-table. A {@link ConceptID} and a {@link RelationID} may read the
 *   same string without colliding; the brands are what keep them apart in a consumer.
 *
 *   Consumed by `./validate.ts` (which refuses a document violating any rule above), by #1926's
 *   deterministic compiler, and by the first authored document in #1927.
 *
 *   Boundary record: `docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md` (#1917).
 */

import type { POICategoryID } from "@mailwoman/poi-taxonomy/types"
import type { Tagged } from "type-fest"

/**
 * A concept identifier, e.g. `pharmacy`, `obtain_medication`. Branded — convert via {@link toConceptID}.
 */
export type ConceptID = Tagged<string, "GeographicConceptID">

/**
 * Brand a raw string as a {@link ConceptID}. Purely a compile-time assertion; the string is unchanged.
 */
export function toConceptID(id: string): ConceptID {
	return id as ConceptID
}

/**
 * A relation identifier, e.g. `affords`. Branded — convert via {@link toRelationID}.
 */
export type RelationID = Tagged<string, "GeographicRelationID">

/**
 * Brand a raw string as a {@link RelationID}. Purely a compile-time assertion; the string is unchanged.
 */
export function toRelationID(id: string): RelationID {
	return id as RelationID
}

/**
 * The identifier of one authored {@link RelationAssertion}. Branded — convert via {@link toRuleID}.
 */
export type RuleID = Tagged<string, "GeographicRuleID">

/**
 * Brand a raw string as a {@link RuleID}. Purely a compile-time assertion; the string is unchanged.
 */
export function toRuleID(id: string): RuleID {
	return id as RuleID
}

/**
 * The identifier of one {@link ExternalMappingRecord}. Branded — convert via {@link toMappingID}.
 */
export type MappingID = Tagged<string, "GeographicMappingID">

/**
 * Brand a raw string as a {@link MappingID}. Purely a compile-time assertion; the string is unchanged.
 */
export function toMappingID(id: string): MappingID {
	return id as MappingID
}

/**
 * The identifier of one {@link SourceObservationRecord}. Branded — convert via {@link toObservationID}.
 */
export type ObservationID = Tagged<string, "GeographicObservationID">

/**
 * Brand a raw string as an {@link ObservationID}. Purely a compile-time assertion; the string is unchanged.
 */
export function toObservationID(id: string): ObservationID {
	return id as ObservationID
}

/**
 * The identifier of one {@link DerivedFactRecord}. Branded — convert via {@link toDerivedFactID}.
 */
export type DerivedFactID = Tagged<string, "GeographicDerivedFactID">

/**
 * Brand a raw string as a {@link DerivedFactID}. Purely a compile-time assertion; the string is unchanged.
 */
export function toDerivedFactID(id: string): DerivedFactID {
	return id as DerivedFactID
}

/**
 * The complete set of concept kinds. Three, deliberately: the first executable slice needs an establishment class, an
 * activity, and the place class an establishment is sited in. Widening this vocabulary is a reviewed schema revision,
 * which is the review cost the program accepted in exchange for refusing speculative upper-ontology breadth.
 */
export const ConceptKind = {
	/**
	 * A geographic place — an area or a point that other things are sited in or near.
	 */
	Place: "place",
	/**
	 * A class of premises a person can go to, e.g. `pharmacy`.
	 */
	Establishment: "establishment",
	/**
	 * Something a person does, e.g. `obtain_medication`. The identifier is owned here; any statistics fitted against it
	 * are owned by #1683.
	 */
	Activity: "activity",
} as const

export type ConceptKind = (typeof ConceptKind)[keyof typeof ConceptKind]

/**
 * How strongly an assertion, an observation, or a derived fact claims its proposition holds.
 *
 * The vocabulary is ordinal in meaning and this module exports no order over it, on purpose. An exported rank would be
 * one arithmetic step from a weight, and an authored weight is the single thing the package boundary forbids.
 */
export const Modality = {
	/**
	 * Holds in every instance; a counter-example falsifies the record rather than qualifying it.
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
	 * Consistent with the concept and asserts nothing about how often it holds.
	 */
	Possible: "possible",
	Unusual: "unusual",
	StronglyUnusual: "strongly_unusual",
} as const

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

export type RelationSemantics = (typeof RelationSemantics)[keyof typeof RelationSemantics]

/**
 * A concept's authoring lifecycle. It says whether a consumer should read the record, and nothing about how much the
 * record is worth.
 */
export const ConceptStatus = {
	/**
	 * Authored, not yet reviewed. A compiler may refuse to emit it.
	 */
	Draft: "draft",
	Active: "active",
	/**
	 * Kept so existing references resolve; no new reference should be authored against it.
	 */
	Deprecated: "deprecated",
} as const

export type ConceptStatus = (typeof ConceptStatus)[keyof typeof ConceptStatus]

/**
 * The external vocabularies a concept can be mapped into. One today, and the mapping record below is typed against it
 * directly; a second vocabulary turns {@link ExternalMappingRecord} into a union discriminated on `vocabulary`.
 */
export const ExternalVocabulary = {
	/**
	 * `@mailwoman/poi-taxonomy` category identifiers — the owner of external and curated POI categories.
	 */
	POITaxonomy: "poi-taxonomy",
} as const

export type ExternalVocabulary = (typeof ExternalVocabulary)[keyof typeof ExternalVocabulary]

/**
 * Where a record came from. `source` is required and non-empty on every record that carries provenance: a record whose
 * source is blank is indistinguishable from a record nobody stands behind.
 */
export interface SourceProvenance {
	/**
	 * The naming authority, dataset, publication, or curator, e.g. `overture-places` or `mailwoman-curated`.
	 */
	source: string
	/**
	 * The source's own version or release string, when it has one, e.g. an Overture release.
	 */
	sourceVersion?: string
	/**
	 * The identifier of the specific record within the source, when the claim is traceable to one.
	 */
	sourceRecord?: string
	sourceURL?: string
	/**
	 * ISO 8601 calendar date the record was authored, `YYYY-MM-DD`.
	 */
	authoredAt?: string
	notes?: string
}

/**
 * One relation's definition. Relations are vocabulary, not claims: the record says what the relation MEANS and which
 * concept kinds may stand on either side of it, and asserts nothing about any particular pair.
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
	 * The relation reading the same edge in the other direction. When present it must resolve, and the relation it names
	 * must name this one back.
	 */
	inverse?: RelationID
	semantics: RelationSemantics
}

/**
 * One authored claim, attached to the concept it is about. This is curated semantics — what a curator states holds, not
 * what a dataset was observed to contain.
 */
export interface RelationAssertion {
	id: RuleID
	relation: RelationID
	target: ConceptID
	modality: Modality
	/**
	 * ISO 3166-1 alpha-2 codes the claim is scoped to. Absent means the curator scoped it to nowhere in particular, which
	 * is a weaker statement than scoping it to everywhere.
	 */
	countries?: string[]
	provenance: SourceProvenance
}

/**
 * One concept, and everything authored about it.
 */
export interface ConceptRecord {
	id: ConceptID
	label: string
	description: string
	kind: ConceptKind
	/**
	 * Broader concepts this one is a kind of. May be empty; may not name this concept, directly or around a cycle.
	 */
	isA: ConceptID[]
	assertions: RelationAssertion[]
	provenance: SourceProvenance
	status: ConceptStatus
}

/**
 * A translation from an external vocabulary's identifier into a concept owned here. It carries no semantics of its own:
 * it says which external identifier names the same thing, and on whose authority.
 */
export interface ExternalMappingRecord {
	id: MappingID
	concept: ConceptID
	vocabulary: ExternalVocabulary
	/**
	 * The identifier in the external vocabulary. Typed as a `POICategoryID` because `poi-taxonomy` is the only member of
	 * {@link ExternalVocabulary}; a second member makes this field a per-vocabulary type.
	 */
	externalID: POICategoryID
	provenance: SourceProvenance
}

/**
 * A proposition a named external source states, recorded in this model's vocabulary.
 *
 * It is kept out of the concept table on purpose. An observation is evidence about the world that someone else
 * collected; promoting one into an authored assertion is a curation decision that has to be made and provenanced
 * explicitly, never by the record sitting in a convenient place.
 */
export interface SourceObservationRecord {
	id: ObservationID
	subject: ConceptID
	relation: RelationID
	object: ConceptID
	modality: Modality
	/**
	 * ISO 3166-1 alpha-2 codes the source scoped its statement to.
	 */
	countries?: string[]
	provenance: SourceProvenance
}

/**
 * Which table a {@link DerivationInput} points into.
 */
export const DerivationInputKind = {
	Concept: "concept",
	Relation: "relation",
	Assertion: "assertion",
	Mapping: "mapping",
	Observation: "observation",
	DerivedFact: "derived_fact",
} as const

export type DerivationInputKind = (typeof DerivationInputKind)[keyof typeof DerivationInputKind]

/**
 * One record a derivation read. The union is discriminated on `kind` so the identifier's brand matches the table it
 * resolves against.
 */
export type DerivationInput =
	| { kind: typeof DerivationInputKind.Concept; id: ConceptID }
	| { kind: typeof DerivationInputKind.Relation; id: RelationID }
	| { kind: typeof DerivationInputKind.Assertion; id: RuleID }
	| { kind: typeof DerivationInputKind.Mapping; id: MappingID }
	| { kind: typeof DerivationInputKind.Observation; id: ObservationID }
	| { kind: typeof DerivationInputKind.DerivedFact; id: DerivedFactID }

/**
 * A fact a named procedure computed from named inputs. Never hand-authored: #1926's compiler writes this table, and the
 * validator refuses a fact whose derivation is unnamed or whose inputs do not resolve.
 *
 * There is no provenance field. The derivation plus the inputs is the provenance and the stronger kind — a source
 * string can be copied onto a record that did not come from it, while an input list either resolves or the document
 * does not validate.
 */
export interface DerivedFactRecord {
	id: DerivedFactID
	/**
	 * The deterministic procedure that produced this fact, named so a reader can re-run it.
	 */
	derivation: string
	/**
	 * Every record the derivation read. At least one, and each must resolve.
	 */
	inputs: DerivationInput[]
	subject: ConceptID
	relation: RelationID
	object: ConceptID
	modality: Modality
	countries?: string[]
}

/**
 * One authored document: the whole record set a validator, and later a compiler, reads at once.
 *
 * All six fields are required, `derivedFacts` included. A hand-authored file therefore writes `"derivedFacts": []`,
 * which is the point — an absent table and an empty table are different claims, and the format that allows the first to
 * stand in for the second is the format where a dropped table reads as a world with no derived facts in it.
 */
export interface GeographicModelDocument {
	/**
	 * The document's own schema/data version.
	 */
	version: string
	relations: RelationRecord[]
	concepts: ConceptRecord[]
	mappings: ExternalMappingRecord[]
	observations: SourceObservationRecord[]
	derivedFacts: DerivedFactRecord[]
}
