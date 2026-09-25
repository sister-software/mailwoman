/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compiles a validated {@link GeographicModelDocument} into the runtime artifact deterministically.
 *
 *   `parseGeographicModelDocument` performs all document validation and throws before compilation
 *   starts. A compile either returns the whole artifact or throws.
 *
 *   Only `isA` defines inheritance. The compiler materializes the transitive `isA` closure for each
 *   concept, and it copies each ancestor's assertions onto descendants as {@link DerivedFactRecord}
 *   entries. The compiler does not close over relations marked `transitive` or `inverse`.
 *
 *   The validator rejects `isA` cycles, but the ancestor walk also tracks visited concepts, so it
 *   terminates on any graph.
 */

import { compareByCodePoint as compareIdentifiers } from "@mailwoman/core/strings/compare"

import { ARTIFACT_SCHEMA_VERSION, type CompiledGeographicModel, type InheritanceClosureEntry } from "#artifact"
import {
	type ConceptID,
	type ConceptRecord,
	type DerivationInput,
	DerivationInputKind,
	type DerivedFactRecord,
	type GeographicModelDocument,
	type RelationAssertion,
	type RelationRecord,
	toConceptID,
	toDerivedFactID,
} from "#schema"
import { parseGeographicModelDocument } from "#validate"
/**
 * The `derivation` value of a fact derived by `isA` inheritance.
 */
export const DERIVATION_ISA_INHERITANCE = "isa-assertion-inheritance"

/**
 * Reasons that compilation rejects a document that passed validation.
 *
 * Both problems concern the derived records, which the validator never sees.
 */
export const CompileIssueCode = {
	/**
	 * An inherited assertion would apply to a concept whose kind the relation's `domainKinds` excludes.
	 */
	InheritedDomainKindMismatch: "inherited_domain_kind_mismatch",
	/**
	 * Two derived facts share one identifier.
	 *
	 * This happens when an authored derived fact uses an identifier that a derivation also
	 * produces, or when authored identifiers contain the separators of the derived form.
	 */
	DuplicateDerivedFactID: "duplicate_derived_fact_id",
} as const

/**
 * A {@link CompileIssueCode} value.
 */

export type CompileIssueCode = (typeof CompileIssueCode)[keyof typeof CompileIssueCode]

/**
 * One reason that a valid document does not compile.
 */
export interface CompileIssue {
	code: CompileIssueCode
	message: string
}

/**
 * The error that {@link compileGeographicModel} throws.
 * Its message lists every issue.
 */
export class GeographicModelCompileError extends Error {
	readonly issues: readonly CompileIssue[]

	constructor(issues: readonly CompileIssue[]) {
		const detail = issues.map((issue) => `${issue.message} [${issue.code}]`).join("\n")

		super(`geographic-model document does not compile (${issues.length} issues)\n${detail}`)

		this.name = "GeographicModelCompileError"
		this.issues = issues
	}
}

/**
 * Sort order of derivation inputs by kind.
 * Identifiers break ties within a kind.
 */
const DERIVATION_INPUT_ORDER: readonly DerivationInputKind[] = [
	DerivationInputKind.Concept,
	DerivationInputKind.Relation,
	DerivationInputKind.Assertion,
	DerivationInputKind.Mapping,
	DerivationInputKind.Observation,
	DerivationInputKind.DerivedFact,
]

/**
 * Separator for internal grouping keys.
 *
 * Identifiers never contain `U+0000`, so distinct key tuples cannot produce the same string.
 */
const KEY_SEPARATOR = "\u0000"

/**
 * Separator between country codes in a derived identifier.
 */
const COUNTRY_SEPARATOR = "+"

function compareByID(left: { id: string }, right: { id: string }): number {
	return compareIdentifiers(left.id, right.id)
}

/**
 * Returns every concept reachable from `conceptID` through `isA`, sorted by code point.
 * The result excludes the concept itself.
 */
function ancestorsOfConcept(
	conceptID: ConceptID,
	parents: ReadonlyMap<string, readonly ConceptID[]>
): readonly ConceptID[] {
	const visited = new Set<string>()
	const frontier: ConceptID[] = [...(parents.get(conceptID) ?? [])]

	// The array iterator also visits entries pushed during the loop, which makes the walk breadth-first.
	for (const next of frontier) {
		if (next === conceptID || visited.has(next)) continue

		visited.add(next)
		frontier.push(...(parents.get(next) ?? []))
	}

	const reachable = [...visited].toSorted(compareIdentifiers)

	return reachable.map(toConceptID)
}

/**
 * One derived fact under construction.
 *
 * Drafts are keyed by subject, relation, target, modality and countries.
 * Two ancestors with the same assertion produce one fact that lists both as inputs.
 *
 * Assertions that differ only in modality produce separate facts, so a contradiction stays visible.
 */
interface DerivedDraft {
	subject: ConceptID
	assertion: RelationAssertion
	countries?: readonly string[]
	inputs: Map<string, DerivationInput>
}

function addInput(draft: DerivedDraft, input: DerivationInput): void {
	draft.inputs.set(`${input.kind}${KEY_SEPARATOR}${input.id}`, input)
}

function draftInputs(draft: DerivedDraft): DerivationInput[] {
	const inputs = [...draft.inputs.values()]

	return inputs.toSorted((left, right) => {
		const byKind = DERIVATION_INPUT_ORDER.indexOf(left.kind) - DERIVATION_INPUT_ORDER.indexOf(right.kind)

		return byKind === 0 ? compareIdentifiers(left.id, right.id) : byKind
	})
}

/**
 * Builds a readable derived-fact identifier from the fact's proposition.
 *
 * The identifier stays stable when unrelated parts of the document change.
 */
function derivedFactID(draft: DerivedDraft): string {
	const scope = draft.countries?.length ? `:${draft.countries.join(COUNTRY_SEPARATOR)}` : ""
	const { relation, target, modality } = draft.assertion

	return `${DERIVATION_ISA_INHERITANCE}:${draft.subject}:${relation}:${target}:${modality}${scope}`
}

/**
 * Returns a key for an assertion's relation and target.
 */
function edgeKey(assertion: RelationAssertion): string {
	return `${assertion.relation}${KEY_SEPARATOR}${assertion.target}`
}

function draftKey(subject: ConceptID, assertion: RelationAssertion, countries: readonly string[] | undefined): string {
	const scope = countries?.join(COUNTRY_SEPARATOR) ?? ""

	return `${subject}${KEY_SEPARATOR}${edgeKey(assertion)}${KEY_SEPARATOR}${assertion.modality}${KEY_SEPARATOR}${scope}`
}

/**
 * Copies each ancestor's assertions onto its descendants as derived facts.
 *
 * A concept's own assertion for a relation and target overrides every inherited assertion for that pair.
 */
function deriveInheritedFacts(
	concepts: readonly ConceptRecord[],
	closure: readonly InheritanceClosureEntry[],
	relations: readonly RelationRecord[],
	issues: CompileIssue[]
): DerivedFactRecord[] {
	const conceptByID = new Map(concepts.map((concept) => [String(concept.id), concept]))
	const relationByID = new Map(relations.map((relation) => [String(relation.id), relation]))
	const drafts = new Map<string, DerivedDraft>()

	for (const entry of closure) {
		const concept = conceptByID.get(String(entry.concept))

		if (!concept) continue

		const authored = new Set(concept.assertions.map(edgeKey))

		for (const ancestorID of entry.ancestors) {
			const ancestor = conceptByID.get(String(ancestorID))

			// Validation guarantees that every referenced concept and relation exists.
			// These guards only satisfy the type checker.
			if (!ancestor) continue

			for (const assertion of ancestor.assertions) {
				if (authored.has(edgeKey(assertion))) continue

				const relation = relationByID.get(String(assertion.relation))

				if (!relation) continue

				if (!relation.domainKinds.includes(concept.kind)) {
					const accepted = relation.domainKinds.map((kind) => `\`${kind}\``).join(", ")

					issues.push({
						code: CompileIssueCode.InheritedDomainKindMismatch,
						message: `\`${concept.id}\` is a \`${concept.kind}\` and is a kind of \`${ancestor.id}\`, whose assertion \`${assertion.id}\` uses relation \`${relation.id}\` — which accepts ${accepted} on the asserting side`,
					})

					continue
				}

				const countries = assertion.countries?.length ? assertion.countries.toSorted(compareIdentifiers) : undefined
				const key = draftKey(concept.id, assertion, countries)
				const existing = drafts.get(key)
				const draft: DerivedDraft = existing ?? { subject: concept.id, assertion, countries, inputs: new Map() }

				addInput(draft, { kind: DerivationInputKind.Concept, id: concept.id })
				addInput(draft, { kind: DerivationInputKind.Concept, id: ancestor.id })
				addInput(draft, { kind: DerivationInputKind.Relation, id: relation.id })
				addInput(draft, { kind: DerivationInputKind.Assertion, id: assertion.id })

				if (!existing) {
					drafts.set(key, draft)
				}
			}
		}
	}

	return [...drafts.values()].map((draft) => ({
		id: toDerivedFactID(derivedFactID(draft)),
		derivation: DERIVATION_ISA_INHERITANCE,
		inputs: draftInputs(draft),
		subject: draft.subject,
		relation: draft.assertion.relation,
		object: draft.assertion.target,
		modality: draft.assertion.modality,
		...(draft.countries ? { countries: [...draft.countries] } : {}),
	}))
}

function checkDerivedIdentifiers(facts: readonly DerivedFactRecord[], issues: CompileIssue[]): void {
	const seen = new Set<string>()

	for (const fact of facts) {
		const id = String(fact.id)

		if (seen.has(id)) {
			issues.push({
				code: CompileIssueCode.DuplicateDerivedFactID,
				message: `two derived facts claim \`${id}\` — an authored derived fact and a derivation cannot share an identifier`,
			})

			continue
		}

		seen.add(id)
	}
}

/**
 * Compiles an authored geographic-model document into its runtime artifact.
 *
 * The artifact's tables are new sorted arrays that hold the authored records unchanged.
 *
 * @throws {GeographicModelValidationError} When the input is not a valid document.
 * @throws {GeographicModelCompileError} When the document is valid but its derived facts are invalid.
 */
export function compileGeographicModel(input: unknown): CompiledGeographicModel {
	const document: GeographicModelDocument = parseGeographicModelDocument(input)
	const concepts = document.concepts.toSorted(compareByID)
	const relations = document.relations.toSorted(compareByID)
	const parents = new Map(concepts.map((concept) => [String(concept.id), concept.isA]))

	const inheritanceClosure: InheritanceClosureEntry[] = concepts.map((concept) => ({
		concept: concept.id,
		ancestors: ancestorsOfConcept(concept.id, parents),
	}))

	const issues: CompileIssue[] = []
	const derived = deriveInheritedFacts(concepts, inheritanceClosure, relations, issues)
	const derivedFacts = [...document.derivedFacts, ...derived].toSorted(compareByID)

	checkDerivedIdentifiers(derivedFacts, issues)

	if (issues.length) throw new GeographicModelCompileError(issues)

	return {
		schemaVersion: ARTIFACT_SCHEMA_VERSION,
		modelVersion: document.version,
		relations,
		concepts,
		mappings: document.mappings.toSorted(compareByID),
		observations: document.observations.toSorted(compareByID),
		inheritanceClosure,
		derivedFacts,
	}
}
