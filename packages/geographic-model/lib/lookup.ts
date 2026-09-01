/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The read surface over a compiled artifact: every question answered by one map probe, none by
 *   walking the graph.
 *
 *   The shape is deliberate. `@mailwoman/geographic-model` compiles authored records into an artifact
 *   precisely so a runtime consumer never traverses anything — so the index exposes lookups
 *   (`concept`, `ancestorsOf`, `derivedFactsAbout`, `conceptsForExternalID`) and no walk, no cursor,
 *   and no query language.
 *
 *   Two absences are distinguished everywhere, because they are different answers. A lookup for a
 *   concept the artifact does not carry returns `undefined` — the model cannot speak to it. A lookup
 *   for a concept it does carry, which nothing was derived about, returns an empty list — the model
 *   carries it and states nothing. A reader that collapsed the two would report "no ancestors" for a
 *   concept it had never heard of.
 */

import type { POICategoryID } from "@mailwoman/poi-taxonomy/types"

import { type CompiledGeographicModel, compareIdentifiers } from "#artifact"
import type {
	ConceptID,
	ConceptRecord,
	DerivedFactRecord,
	ExternalVocabulary,
	RelationID,
	RelationRecord,
} from "#schema"

/**
 * Lookups over one compiled artifact.
 */
export interface GeographicModelIndex {
	/**
	 * The artifact these lookups read, so a consumer holding the index never has to carry both.
	 */
	readonly model: CompiledGeographicModel
	/**
	 * One concept record, or `undefined` when the artifact does not carry it.
	 */
	concept(id: ConceptID): ConceptRecord | undefined
	/**
	 * One relation definition, or `undefined` when the artifact does not carry it.
	 */
	relation(id: RelationID): RelationRecord | undefined
	/**
	 * Every concept this one is a kind of, transitively, in code-point order. Empty for a concept that is a kind of
	 * nothing; `undefined` for a concept the artifact does not carry.
	 */
	ancestorsOf(id: ConceptID): readonly ConceptID[] | undefined
	/**
	 * Every derived fact whose subject is this concept, in artifact order. Empty for a concept nothing was derived about;
	 * `undefined` for a concept the artifact does not carry.
	 */
	derivedFactsAbout(id: ConceptID): readonly DerivedFactRecord[] | undefined
	/**
	 * The concepts a mapping translates this external identifier into, in code-point order.
	 *
	 * An empty list is a true negative rather than an unread answer: the artifact carries every mapping the document
	 * authored, so nothing having declared this identifier is the whole of what there is to know about it.
	 */
	conceptsForExternalID(vocabulary: ExternalVocabulary, externalID: POICategoryID): readonly ConceptID[]
}

function externalKey(vocabulary: ExternalVocabulary, externalID: string): string {
	return `${vocabulary}\u0000${externalID}`
}

/**
 * Index a compiled artifact for reading.
 *
 * Every table is walked once here so that no table is ever walked again. Nothing is copied — the records handed back
 * are the artifact's own.
 */
export function createGeographicModelIndex(model: CompiledGeographicModel): GeographicModelIndex {
	const concepts = new Map<string, ConceptRecord>(model.concepts.map((concept) => [String(concept.id), concept]))
	const relations = new Map<string, RelationRecord>(model.relations.map((relation) => [String(relation.id), relation]))

	const ancestors = new Map<string, readonly ConceptID[]>(
		model.inheritanceClosure.map((entry) => [String(entry.concept), entry.ancestors])
	)

	const facts = new Map<string, DerivedFactRecord[]>()
	const external = new Map<string, ConceptID[]>()

	for (const fact of model.derivedFacts) {
		const subject = String(fact.subject)
		const existing = facts.get(subject)

		if (existing) {
			existing.push(fact)

			continue
		}

		facts.set(subject, [fact])
	}

	for (const mapping of model.mappings) {
		const key = externalKey(mapping.vocabulary, String(mapping.externalID))
		const existing = external.get(key)

		if (!existing) {
			external.set(key, [mapping.concept])

			continue
		}

		if (!existing.includes(mapping.concept)) {
			existing.push(mapping.concept)
		}
	}

	return {
		model,
		concept: (id) => concepts.get(String(id)),
		relation: (id) => relations.get(String(id)),
		ancestorsOf: (id) => ancestors.get(String(id)),
		derivedFactsAbout: (id) => (concepts.has(String(id)) ? (facts.get(String(id)) ?? []) : undefined),
		conceptsForExternalID: (vocabulary, externalID) => {
			const matches = external.get(externalKey(vocabulary, String(externalID)))

			return matches ? matches.toSorted(compareIdentifiers) : []
		},
	}
}
