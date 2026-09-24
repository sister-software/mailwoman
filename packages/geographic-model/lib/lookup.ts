/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read-only lookups over a compiled artifact. Queries use prebuilt maps rather than traversing the graph.
 *   Missing concepts return `undefined`; known concepts with no related facts return an empty list.
 */

import { compareByCodePoint as compareIdentifiers } from "@mailwoman/core/strings/compare"
import type { POICategoryID } from "@mailwoman/poi-taxonomy/types"

import type { CompiledGeographicModel } from "#artifact"
import type {
	ConceptID,
	ConceptRecord,
	DerivedFactRecord,
	ExternalVocabulary,
	RelationID,
	RelationRecord,
} from "#schema"

/**
 * Lookup methods for one compiled artifact.
 */
export interface GeographicModelIndex {
	/**
	 * Compiled artifact used by this index.
	 */
	readonly model: CompiledGeographicModel
	/**
	 * Concept record, or `undefined` if absent.
	 */
	concept(id: ConceptID): ConceptRecord | undefined
	/**
	 * Relation definition, or `undefined` if absent.
	 */
	relation(id: RelationID): RelationRecord | undefined
	/**
	 * Transitive ancestors in code-point order; `undefined` if the concept is absent.
	 */
	ancestorsOf(id: ConceptID): readonly ConceptID[] | undefined
	/**
	 * Derived facts in artifact order; `undefined` if the concept is absent.
	 */
	derivedFactsAbout(id: ConceptID): readonly DerivedFactRecord[] | undefined
	/**
	 * Concepts mapped from this external ID, in code-point order.
	 * An empty list means no mapping is recorded.
	 */
	conceptsForExternalID(vocabulary: ExternalVocabulary, externalID: POICategoryID): readonly ConceptID[]
}

function externalKey(vocabulary: ExternalVocabulary, externalID: string): string {
	return `${vocabulary}\u0000${externalID}`
}

/**
 * Build lookup maps over a compiled artifact.
 *
 * Return references to the artifact's records without copying them.
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
