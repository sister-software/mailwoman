/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deterministic compilation of a validated {@link GeographicModelDocument} into the runtime artifact.
 *
 *   The compiler validates by DELEGATION: `parseGeographicModelDocument` is the only thing that
 *   decides whether a document is well formed, and it throws with every violation before a single byte
 *   is computed. There is no second validator here, and no partial artifact on failure — a compile
 *   either produces the whole artifact or produces nothing.
 *
 *   **`isA` alone defines semantic inheritance.** Two things follow from it, and they are the whole
 *   derivation surface:
 *
 *   1. The transitive `isA` closure is materialized per concept, so a consumer asks "what is this a
 *      kind of" with one lookup rather than by walking the graph at query time.
 *   2. Every assertion an ancestor carries is materialized onto its descendants as a
 *      {@link DerivedFactRecord}, naming {@link DERIVATION_ISA_INHERITANCE} and every record the
 *      derivation read. Without this a consumer would still be traversing — the closure alone tells it
 *      which concepts to go and read, which is the traversal it was supposed to be spared.
 *
 *   A relation declaring `transitive` or `inverse` is NOT closed over. Those fields are vocabulary
 *   describing what the relation means; materializing them is a reasoning step no executable need has
 *   asked for, and the boundary record excludes general reasoning from this package. The day one is
 *   needed it arrives as its own named derivation beside this one.
 *
 *   Cycles never reach the derivations: `parseGeographicModelDocument` refuses a direct or indirect
 *   `isA` cycle and names the trail it followed, so a cyclic document fails as a validation error
 *   rather than as a hang. The walk below is breadth-first over a visited set regardless, which makes
 *   it total for any graph rather than for the graphs the validator happens to admit.
 */

import {
	ARTIFACT_SCHEMA_VERSION,
	type CompiledGeographicModel,
	compareIdentifiers,
	type InheritanceClosureEntry,
} from "#artifact"
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
 * The name a fact derived by `isA` inheritance carries in its `derivation` field. A consumer branches on this rather
 * than on where the record sits.
 */
export const DERIVATION_ISA_INHERITANCE = "isa-assertion-inheritance"

/**
 * Every way compilation can refuse a document the validator accepted.
 *
 * Both are discovered while writing derived records, which is why the validator cannot report them: they are properties
 * of what the compiler is about to write, not of what the author wrote.
 */
export const CompileIssueCode = {
	/**
	 * An inherited assertion would land on a concept whose kind the relation does not accept on the asserting side.
	 * Emitting it would put a record in the artifact that the document validator would reject if it were authored.
	 */
	InheritedDomainKindMismatch: "inherited_domain_kind_mismatch",
	/**
	 * Two derived facts claim one identifier. Reachable when an authored derived fact takes an identifier a derivation
	 * also produces, or when authored identifiers carry the separators the derived form is built from.
	 */
	DuplicateDerivedFactID: "duplicate_derived_fact_id",
} as const

export type CompileIssueCode = (typeof CompileIssueCode)[keyof typeof CompileIssueCode]

/**
 * One reason a document that validates does not compile.
 */
export interface CompileIssue {
	code: CompileIssueCode
	message: string
}

/**
 * Thrown by {@link compileGeographicModel}. Carries every reason at once, and states them all in its message, so a
 * caller that only prints `error.message` still sees the whole list.
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
 * The order derivation inputs are listed in. Grouping by table first keeps a long input list readable; the identifier
 * breaks ties inside a table.
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
 * The separator for the compound keys this module groups by. `U+0000` cannot appear in a readable identifier without
 * being visible in it, so two different key tuples cannot collapse onto one string. The derived IDENTIFIERS written
 * into the artifact use readable separators instead, and are checked for collisions once they are all built.
 */
const KEY_SEPARATOR = "\u0000"

/**
 * The separator between country codes inside a derived identifier.
 */
const COUNTRY_SEPARATOR = "+"

function compareByID(left: { id: string }, right: { id: string }): number {
	return compareIdentifiers(left.id, right.id)
}

/**
 * Walk `isA` upward from one concept and return every concept reachable, in code-point order.
 *
 * Breadth-first over a visited set: each concept is expanded once, so the walk terminates on any graph and the answer
 * does not depend on how the parents were authored. The concept itself is never in its own list — it could only get
 * there around a cycle, and the validator refuses those before the compiler runs.
 */
function ancestorsOfConcept(
	conceptID: ConceptID,
	parents: ReadonlyMap<string, readonly ConceptID[]>
): readonly ConceptID[] {
	const visited = new Set<string>()
	const frontier: ConceptID[] = [...(parents.get(conceptID) ?? [])]

	// An array iterator reads entries appended during the walk, which is what makes this breadth-first rather than a
	// pass over the direct parents.
	for (const next of frontier) {
		if (next === conceptID || visited.has(next)) continue

		visited.add(next)
		frontier.push(...(parents.get(next) ?? []))
	}

	const reachable = [...visited].toSorted(compareIdentifiers)

	return reachable.map(toConceptID)
}

/**
 * One derived fact under construction. Drafts are keyed by the proposition they state, so two ancestors asserting the
 * same thing produce ONE fact naming both of them as inputs, while two ancestors asserting the same triple under
 * different modality produce two facts — a contradiction a consumer can see, rather than a silent choice between them.
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
 * The identifier a derived fact carries. Built from the proposition it states, so it is stable across edits elsewhere
 * in the document, and readable, so a reader meeting one in a diff can tell what it says.
 */
function derivedFactID(draft: DerivedDraft): string {
	const scope = draft.countries?.length ? `:${draft.countries.join(COUNTRY_SEPARATOR)}` : ""
	const { relation, target, modality } = draft.assertion

	return `${DERIVATION_ISA_INHERITANCE}:${draft.subject}:${relation}:${target}:${modality}${scope}`
}

/**
 * The relation and target one assertion is about — the pair a descendant's own assertion speaks for.
 */
function edgeKey(assertion: RelationAssertion): string {
	return `${assertion.relation}${KEY_SEPARATOR}${assertion.target}`
}

function draftKey(subject: ConceptID, assertion: RelationAssertion, countries: readonly string[] | undefined): string {
	const scope = countries?.join(COUNTRY_SEPARATOR) ?? ""

	return `${subject}${KEY_SEPARATOR}${edgeKey(assertion)}${KEY_SEPARATOR}${assertion.modality}${KEY_SEPARATOR}${scope}`
}

/**
 * Materialize every ancestor's assertions onto their descendants.
 *
 * A concept that authors its own assertion for the same relation and target inherits nothing for that pair. The
 * authored record is the more specific one, which is what `isA` means, and re-stating the pair would put two modalities
 * for one proposition into the artifact with no rule saying which of them holds.
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

			// Validation refuses an `isA` naming an undeclared concept, and an assertion naming an undeclared relation,
			// so both resolve for any document that reached the compiler. The guards keep the walk total; they do not
			// describe a state the artifact can hold.
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
 * Compile an authored geographic-model document into its runtime artifact.
 *
 * Throws `GeographicModelValidationError` with every violation if the input is not a valid document, and
 * {@link GeographicModelCompileError} with every reason if it validates but its derivations cannot be written. Nothing
 * partial is ever returned.
 *
 * The document is read, never rewritten: the artifact's tables are new arrays holding the authored records themselves,
 * ordered by identifier, and the derived tables are new records built beside them.
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
