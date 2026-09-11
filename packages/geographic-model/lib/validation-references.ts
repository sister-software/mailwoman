/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Validates references among geographic-model records after shape reading.
 */

import type { ConceptKind } from "#schema"
import { DerivationInputKind } from "#schema"
import type {
	AssertionView,
	ConceptView,
	DerivedFactView,
	DocumentView,
	ReferenceTables,
	RelationView,
} from "#validate"
import { add, listVocabulary, type ValidationIssue, ValidationIssueCode } from "#validation-issues"

/**
 * Index a table by identifier, reporting every record after the first that claims an identifier already taken.
 */
function indexByID<T extends { path: string; id?: string }>(
	issues: ValidationIssue[],
	records: readonly T[],
	label: string
): Map<string, T> {
	const index = new Map<string, T>()

	for (const record of records) {
		if (record.id === undefined) continue

		if (index.has(record.id)) {
			add(
				issues,
				`${record.path}.id`,
				ValidationIssueCode.DuplicateID,
				`\`${record.id}\` is already used by another ${label}`
			)

			continue
		}

		index.set(record.id, record)
	}

	return index
}

interface EdgeCheck {
	subjectKind?: ConceptKind
	subjectPath: string
	relationID?: string
	relationPath: string
	objectID?: string
	objectPath: string
}

/**
 * Resolve one subject–relation–object edge and check it against the relation's declared domain and range kinds.
 *
 * Shared by authored assertions, source observations, and derived facts. The three differ in who stands behind them and
 * in what provenance they carry, and the structural question asked of them is the same one.
 */
function checkEdge(issues: ValidationIssue[], edge: EdgeCheck, tables: ReferenceTables): void {
	const relation = edge.relationID === undefined ? undefined : tables.relations.get(edge.relationID)

	if (edge.relationID !== undefined && !relation) {
		add(
			issues,
			edge.relationPath,
			ValidationIssueCode.UnknownRelation,
			`\`${edge.relationID}\` is not a relation declared in this document`
		)
	}

	const object = edge.objectID === undefined ? undefined : tables.concepts.get(edge.objectID)

	if (edge.objectID !== undefined && !object) {
		add(
			issues,
			edge.objectPath,
			ValidationIssueCode.UnknownConcept,
			`\`${edge.objectID}\` is not a concept declared in this document`
		)
	}

	if (!relation) return

	if (edge.subjectKind && relation.domainKinds && !relation.domainKinds.includes(edge.subjectKind)) {
		add(
			issues,
			edge.subjectPath,
			ValidationIssueCode.DomainKindMismatch,
			`relation \`${relation.id}\` accepts ${listVocabulary(relation.domainKinds)} on the asserting side, not \`${edge.subjectKind}\``
		)
	}

	if (object?.kind && relation.rangeKinds && !relation.rangeKinds.includes(object.kind)) {
		add(
			issues,
			edge.objectPath,
			ValidationIssueCode.RangeKindMismatch,
			`relation \`${relation.id}\` accepts ${listVocabulary(relation.rangeKinds)} on the target side, not \`${object.kind}\``
		)
	}
}

function sameKinds(left: readonly ConceptKind[], right: readonly ConceptKind[]): boolean {
	return left.length === right.length && left.every((kind) => right.includes(kind))
}

/**
 * Check one relation's inverse and its transitivity against the kinds it declares.
 */
function checkRelation(
	issues: ValidationIssue[],
	relation: RelationView,
	index: ReadonlyMap<string, RelationView>
): void {
	const inversePath = `${relation.path}.inverse`

	if (relation.transitive === true && relation.domainKinds && relation.rangeKinds) {
		const chainable = relation.rangeKinds.some((kind) => relation.domainKinds?.includes(kind))

		if (!chainable) {
			add(
				issues,
				`${relation.path}.transitive`,
				ValidationIssueCode.TransitiveKindsDisjoint,
				"a transitive relation has to be able to chain, so its range kinds and its domain kinds must overlap"
			)
		}
	}

	if (relation.inverse === undefined) return

	const inverse = index.get(relation.inverse)

	if (!inverse) {
		add(
			issues,
			inversePath,
			ValidationIssueCode.UnknownRelation,
			`\`${relation.inverse}\` is not a relation declared in this document`
		)

		return
	}

	if (relation.symmetric === true && inverse.id !== relation.id) {
		add(
			issues,
			inversePath,
			ValidationIssueCode.InverseNotReciprocal,
			`\`${relation.id}\` is symmetric, so it is its own inverse; it names \`${relation.inverse}\``
		)

		return
	}

	if (inverse.inverse !== relation.id) {
		add(
			issues,
			inversePath,
			ValidationIssueCode.InverseNotReciprocal,
			`\`${relation.inverse}\` does not name \`${relation.id}\` as its own inverse`
		)
	}

	if (
		inverse.id !== relation.id &&
		relation.domainKinds &&
		relation.rangeKinds &&
		inverse.domainKinds &&
		inverse.rangeKinds &&
		!(sameKinds(relation.domainKinds, inverse.rangeKinds) && sameKinds(relation.rangeKinds, inverse.domainKinds))
	) {
		add(
			issues,
			inversePath,
			ValidationIssueCode.InverseKindsMismatch,
			`an inverse reads the same edge backwards, so \`${relation.inverse}\` has to declare this relation's range kinds as its domain kinds, and the reverse`
		)
	}
}

/**
 * Follow `isA` upward from one concept and report the trail if it returns to where it started.
 *
 * The direct self-edge is left out of the walk: `checkIsA` already reports that as a self-reference, at the entry that
 * carries it, and a second report saying the same concept cycles through itself tells its author nothing new.
 */
function findIsACycle(start: ConceptView, concepts: ReadonlyMap<string, ConceptView>): string[] | undefined {
	if (start.id === undefined) return undefined

	const startID = start.id
	const visited = new Set<string>()

	const frontier: Array<{ id: string; trail: string[] }> = (start.isA ?? [])
		.filter((parent) => parent !== startID)
		.map((parent) => ({ id: parent, trail: [startID, parent] }))

	while (frontier.length) {
		const step = frontier.pop()

		if (!step) break

		if (step.id === startID) return step.trail

		if (visited.has(step.id)) continue

		visited.add(step.id)

		for (const parent of concepts.get(step.id)?.isA ?? []) {
			frontier.push({ id: parent, trail: [...step.trail, parent] })
		}
	}

	return undefined
}

function checkIsA(issues: ValidationIssue[], concept: ConceptView, concepts: ReadonlyMap<string, ConceptView>): void {
	if (!concept.isA) return

	for (const [index, parent] of concept.isA.entries()) {
		const parentPath = `${concept.path}.isA[${index}]`

		if (parent === concept.id) {
			add(issues, parentPath, ValidationIssueCode.SelfReference, "a concept is not a kind of itself")

			continue
		}

		if (!concepts.has(parent)) {
			add(
				issues,
				parentPath,
				ValidationIssueCode.UnknownConcept,
				`\`${parent}\` is not a concept declared in this document`
			)
		}
	}

	const cycle = findIsACycle(concept, concepts)

	if (cycle) {
		add(issues, `${concept.path}.isA`, ValidationIssueCode.CyclicIsA, `\`isA\` cycles through ${cycle.join(" → ")}`)
	}
}

function checkDerivationInputs(issues: ValidationIssue[], fact: DerivedFactView, tables: ReferenceTables): void {
	const byKind: Record<DerivationInputKind, ReadonlyMap<string, unknown>> = {
		[DerivationInputKind.Concept]: tables.concepts,
		[DerivationInputKind.Relation]: tables.relations,
		[DerivationInputKind.Assertion]: tables.assertions,
		[DerivationInputKind.Mapping]: tables.mappings,
		[DerivationInputKind.Observation]: tables.observations,
		[DerivationInputKind.DerivedFact]: tables.derivedFacts,
	}

	for (const input of fact.inputs) {
		if (input.kind === undefined || input.id === undefined) continue

		if (input.kind === DerivationInputKind.DerivedFact && input.id === fact.id) {
			add(issues, `${input.path}.id`, ValidationIssueCode.SelfReference, "a derived fact is not one of its own inputs")

			continue
		}

		if (!byKind[input.kind].has(input.id)) {
			add(
				issues,
				`${input.path}.id`,
				ValidationIssueCode.UnknownDerivationInput,
				`no \`${input.kind}\` record in this document is identified by \`${input.id}\``
			)
		}
	}
}

export function checkReferences(issues: ValidationIssue[], view: DocumentView): void {
	const assertions: AssertionView[] = []

	for (const concept of view.concepts) {
		assertions.push(...concept.assertions)
	}

	const relations = indexByID(issues, view.relations, "relation")
	const concepts = indexByID(issues, view.concepts, "concept")

	const tables: ReferenceTables = {
		relations,
		concepts,
		assertions: indexByID(issues, assertions, "assertion"),
		mappings: indexByID(issues, view.mappings, "mapping"),
		observations: indexByID(issues, view.observations, "observation"),
		derivedFacts: indexByID(issues, view.derivedFacts, "derived fact"),
	}

	for (const relation of view.relations) {
		checkRelation(issues, relation, relations)
	}

	for (const concept of view.concepts) {
		checkIsA(issues, concept, concepts)

		for (const assertion of concept.assertions) {
			checkEdge(
				issues,
				{
					subjectKind: concept.kind,
					subjectPath: `${assertion.path}.relation`,
					relationID: assertion.relation,
					relationPath: `${assertion.path}.relation`,
					objectID: assertion.target,
					objectPath: `${assertion.path}.target`,
				},
				tables
			)
		}
	}

	for (const mapping of view.mappings) {
		if (mapping.concept !== undefined && !concepts.has(mapping.concept)) {
			add(
				issues,
				`${mapping.path}.concept`,
				ValidationIssueCode.UnknownConcept,
				`\`${mapping.concept}\` is not a concept declared in this document`
			)
		}
	}

	for (const triple of [...view.observations, ...view.derivedFacts]) {
		const subject = triple.subject === undefined ? undefined : concepts.get(triple.subject)

		if (triple.subject !== undefined && !subject) {
			add(
				issues,
				`${triple.path}.subject`,
				ValidationIssueCode.UnknownConcept,
				`\`${triple.subject}\` is not a concept declared in this document`
			)
		}

		checkEdge(
			issues,
			{
				subjectKind: subject?.kind,
				subjectPath: `${triple.path}.subject`,
				relationID: triple.relation,
				relationPath: `${triple.path}.relation`,
				objectID: triple.object,
				objectPath: `${triple.path}.object`,
			},
			tables
		)
	}

	for (const fact of view.derivedFacts) {
		checkDerivationInputs(issues, fact, tables)
	}
}
