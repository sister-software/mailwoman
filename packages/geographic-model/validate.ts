/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deterministic validation of a {@link GeographicModelDocument}. Plain TypeScript: no reasoner, no
 *   query engine, no schema library, and no I/O — the same input always produces the same issue list.
 *
 *   The validator reports EVERY violation it finds. A record set is authored by hand and read by a
 *   compiler, so a validator that stops at the first problem hands its author one defect per run. It
 *   also never returns a partial document: either the input satisfies every rule and is returned
 *   whole, or nothing is returned and every issue is named with the path it was found at. There is no
 *   third answer in which some records were dropped quietly, because a dropped record is
 *   indistinguishable from a world that does not contain it.
 *
 *   Two passes, in this order, and both always run:
 *
 *   1. **Shape.** Field presence, field types, closed-vocabulary membership, and unknown keys. An
 *      unknown key whose name announces ranking policy — a boost, a penalty, a weight, a rank, a
 *      score — is reported under its own code rather than as an anonymous stray field, because that
 *      is the one authoring mistake this package exists to refuse.
 *   2. **Whole-table references.** Duplicate identifiers, `isA` self-reference and cycles, relation
 *      and concept resolution, relation domain and range kinds, inverse reciprocity, and derivation
 *      inputs. These are answerable only once every table has been read, which is why they are
 *      reported after the shape issues rather than interleaved with them.
 *
 *   Consumed by #1926's compiler, which validates before it emits, and by #1927's authored document.
 */

import { isPlainObject } from "@mailwoman/core/objects"

import {
	ConceptKind,
	ConceptStatus,
	DerivationInputKind,
	ExternalVocabulary,
	type GeographicModelDocument,
	Modality,
	RelationSemantics,
} from "#schema"
import {
	add,
	checkFieldNames,
	listVocabulary,
	readArray,
	readBoolean,
	readString,
	readStringArray,
	readVocabularyArray,
	readVocabularyValue,
	type ValidationIssue,
	ValidationIssueCode,
} from "#validation-issues"

export { type ValidationIssue, ValidationIssueCode } from "#validation-issues"

/**
 * The whole document, or every reason it is not one.
 */
export type ValidationResult =
	| { ok: true; document: GeographicModelDocument }
	| { ok: false; issues: ValidationIssue[] }

const DOCUMENT_FIELDS = ["version", "relations", "concepts", "mappings", "observations", "derivedFacts"] as const
const PROVENANCE_FIELDS = ["source", "sourceVersion", "sourceRecord", "sourceURL", "authoredAt", "notes"] as const
const OPTIONAL_PROVENANCE_FIELDS = ["sourceVersion", "sourceRecord", "sourceURL", "authoredAt", "notes"] as const

const RELATION_FIELDS = [
	"id",
	"label",
	"description",
	"domainKinds",
	"rangeKinds",
	"transitive",
	"symmetric",
	"inverse",
	"semantics",
] as const

const ASSERTION_FIELDS = ["id", "relation", "target", "modality", "countries", "provenance"] as const
const CONCEPT_FIELDS = ["id", "label", "description", "kind", "isA", "assertions", "provenance", "status"] as const
const MAPPING_FIELDS = ["id", "concept", "vocabulary", "externalID", "provenance"] as const
const OBSERVATION_FIELDS = ["id", "subject", "relation", "object", "modality", "countries", "provenance"] as const

const DERIVED_FACT_FIELDS = [
	"id",
	"derivation",
	"inputs",
	"subject",
	"relation",
	"object",
	"modality",
	"countries",
] as const

const DERIVATION_INPUT_FIELDS = ["kind", "id"] as const

/**
 * ISO 3166-1 alpha-2, upper case. A lower-case or three-letter value is an authoring mistake that would otherwise scope
 * a claim to a country nothing else in the system names.
 */
const COUNTRY_PATTERN = /^[A-Z]{2}$/

interface AssertionView {
	path: string
	id?: string
	relation?: string
	target?: string
}

interface ConceptView {
	path: string
	id?: string
	kind?: ConceptKind
	isA?: string[]
	assertions: AssertionView[]
}

interface RelationView {
	path: string
	id?: string
	domainKinds?: ConceptKind[]
	rangeKinds?: ConceptKind[]
	transitive?: boolean
	symmetric?: boolean
	inverse?: string
}

interface MappingView {
	path: string
	id?: string
	concept?: string
}

interface TripleView {
	path: string
	id?: string
	subject?: string
	relation?: string
	object?: string
}

interface DerivationInputView {
	path: string
	kind?: DerivationInputKind
	id?: string
}

interface DerivedFactView extends TripleView {
	inputs: DerivationInputView[]
}

interface DocumentView {
	relations: RelationView[]
	concepts: ConceptView[]
	mappings: MappingView[]
	observations: TripleView[]
	derivedFacts: DerivedFactView[]
}

interface ReferenceTables {
	concepts: Map<string, ConceptView>
	relations: Map<string, RelationView>
	assertions: ReadonlyMap<string, unknown>
	mappings: ReadonlyMap<string, unknown>
	observations: ReadonlyMap<string, unknown>
	derivedFacts: ReadonlyMap<string, unknown>
}

function readCountries(issues: ValidationIssue[], path: string, container: Record<string, unknown>): void {
	const values = readStringArray(issues, path, container, "countries", false)

	if (!values) return

	for (const [index, value] of values.entries()) {
		if (!COUNTRY_PATTERN.test(value)) {
			add(
				issues,
				`${path}.countries[${index}]`,
				ValidationIssueCode.MalformedCountry,
				`\`${value}\` is not an upper-case ISO 3166-1 alpha-2 code`
			)
		}
	}
}

function readProvenance(issues: ValidationIssue[], path: string, container: Record<string, unknown>): void {
	const value = container.provenance
	const fieldPath = `${path}.provenance`

	if (value === undefined) {
		add(issues, fieldPath, ValidationIssueCode.MissingField, "`provenance` is required")

		return
	}

	if (!isPlainObject(value)) {
		add(issues, fieldPath, ValidationIssueCode.WrongType, "`provenance` must be an object")

		return
	}

	checkFieldNames(issues, fieldPath, value, PROVENANCE_FIELDS)
	readString(issues, fieldPath, value, "source", true)

	for (const key of OPTIONAL_PROVENANCE_FIELDS) {
		readString(issues, fieldPath, value, key, false)
	}
}

/**
 * Read the `label` and `description` an authored record carries.
 */
function readNarration(issues: ValidationIssue[], path: string, value: Record<string, unknown>): void {
	readString(issues, path, value, "label", true)
	readString(issues, path, value, "description", true)
}

function readRelation(issues: ValidationIssue[], path: string, value: Record<string, unknown>): RelationView {
	const conceptKinds = Object.values(ConceptKind)

	checkFieldNames(issues, path, value, RELATION_FIELDS)

	const id = readString(issues, path, value, "id", true)

	readNarration(issues, path, value)

	const kindCode = ValidationIssueCode.UnknownConceptKind
	const domainKinds = readVocabularyArray(issues, path, value, "domainKinds", conceptKinds, kindCode)
	const rangeKinds = readVocabularyArray(issues, path, value, "rangeKinds", conceptKinds, kindCode)
	const transitive = readBoolean(issues, path, value, "transitive")
	const symmetric = readBoolean(issues, path, value, "symmetric")
	const inverse = readString(issues, path, value, "inverse", false)

	readVocabularyValue(
		issues,
		path,
		value,
		"semantics",
		Object.values(RelationSemantics),
		ValidationIssueCode.UnknownRelationSemantics
	)

	return { path, id, domainKinds, rangeKinds, transitive, symmetric, inverse }
}

function readAssertion(issues: ValidationIssue[], path: string, value: Record<string, unknown>): AssertionView {
	checkFieldNames(issues, path, value, ASSERTION_FIELDS)

	const id = readString(issues, path, value, "id", true)
	const relation = readString(issues, path, value, "relation", true)
	const target = readString(issues, path, value, "target", true)

	readVocabularyValue(issues, path, value, "modality", Object.values(Modality), ValidationIssueCode.UnknownModality)
	readCountries(issues, path, value)
	readProvenance(issues, path, value)

	return { path, id, relation, target }
}

function readConcept(issues: ValidationIssue[], path: string, value: Record<string, unknown>): ConceptView {
	checkFieldNames(issues, path, value, CONCEPT_FIELDS)

	const id = readString(issues, path, value, "id", true)

	readNarration(issues, path, value)

	const kind = readVocabularyValue(
		issues,
		path,
		value,
		"kind",
		Object.values(ConceptKind),
		ValidationIssueCode.UnknownConceptKind
	)

	const isA = readStringArray(issues, path, value, "isA", true)
	const assertions: AssertionView[] = []

	for (const [index, entry] of (readArray(issues, path, value, "assertions", true) ?? []).entries()) {
		const entryPath = `${path}.assertions[${index}]`

		if (!isPlainObject(entry)) {
			add(issues, entryPath, ValidationIssueCode.WrongType, "an assertion must be an object")

			continue
		}

		assertions.push(readAssertion(issues, entryPath, entry))
	}

	readProvenance(issues, path, value)

	readVocabularyValue(
		issues,
		path,
		value,
		"status",
		Object.values(ConceptStatus),
		ValidationIssueCode.UnknownConceptStatus
	)

	return { path, id, kind, isA, assertions }
}

function readMapping(issues: ValidationIssue[], path: string, value: Record<string, unknown>): MappingView {
	checkFieldNames(issues, path, value, MAPPING_FIELDS)

	const id = readString(issues, path, value, "id", true)
	const concept = readString(issues, path, value, "concept", true)

	readVocabularyValue(
		issues,
		path,
		value,
		"vocabulary",
		Object.values(ExternalVocabulary),
		ValidationIssueCode.UnknownExternalVocabulary
	)

	readString(issues, path, value, "externalID", true)
	readProvenance(issues, path, value)

	return { path, id, concept }
}

function readObservation(issues: ValidationIssue[], path: string, value: Record<string, unknown>): TripleView {
	checkFieldNames(issues, path, value, OBSERVATION_FIELDS)

	const id = readString(issues, path, value, "id", true)
	const subject = readString(issues, path, value, "subject", true)
	const relation = readString(issues, path, value, "relation", true)
	const object = readString(issues, path, value, "object", true)

	readVocabularyValue(issues, path, value, "modality", Object.values(Modality), ValidationIssueCode.UnknownModality)
	readCountries(issues, path, value)
	readProvenance(issues, path, value)

	return { path, id, subject, relation, object }
}

function readDerivationInput(
	issues: ValidationIssue[],
	path: string,
	value: Record<string, unknown>
): DerivationInputView {
	checkFieldNames(issues, path, value, DERIVATION_INPUT_FIELDS)

	const kind = readVocabularyValue(
		issues,
		path,
		value,
		"kind",
		Object.values(DerivationInputKind),
		ValidationIssueCode.UnknownDerivationInputKind
	)

	return { path, kind, id: readString(issues, path, value, "id", true) }
}

function readDerivedFact(issues: ValidationIssue[], path: string, value: Record<string, unknown>): DerivedFactView {
	checkFieldNames(issues, path, value, DERIVED_FACT_FIELDS)

	const id = readString(issues, path, value, "id", true)

	readString(issues, path, value, "derivation", true)

	const entries = readArray(issues, path, value, "inputs", true)
	const inputs: DerivationInputView[] = []

	if (entries && !entries.length) {
		add(
			issues,
			`${path}.inputs`,
			ValidationIssueCode.EmptyList,
			"a derived fact names the records its derivation read; an empty list is a fact with no provenance"
		)
	}

	for (const [index, entry] of (entries ?? []).entries()) {
		const entryPath = `${path}.inputs[${index}]`

		if (!isPlainObject(entry)) {
			add(issues, entryPath, ValidationIssueCode.WrongType, "a derivation input must be an object")

			continue
		}

		inputs.push(readDerivationInput(issues, entryPath, entry))
	}

	const subject = readString(issues, path, value, "subject", true)
	const relation = readString(issues, path, value, "relation", true)
	const object = readString(issues, path, value, "object", true)

	readVocabularyValue(issues, path, value, "modality", Object.values(Modality), ValidationIssueCode.UnknownModality)
	readCountries(issues, path, value)

	return { path, id, inputs, subject, relation, object }
}

function readTable<T>(
	issues: ValidationIssue[],
	document: Record<string, unknown>,
	key: string,
	label: string,
	read: (issues: ValidationIssue[], path: string, value: Record<string, unknown>) => T
): T[] {
	const entries = readArray(issues, "$", document, key, true)
	const records: T[] = []

	for (const [index, entry] of (entries ?? []).entries()) {
		const entryPath = `$.${key}[${index}]`

		if (!isPlainObject(entry)) {
			add(issues, entryPath, ValidationIssueCode.WrongType, `a ${label} must be an object`)

			continue
		}

		records.push(read(issues, entryPath, entry))
	}

	return records
}

/**
 * Index a table by identifier, reporting every record after the first that claims an identifier already taken. The
 * first claimant keeps the identifier, so a duplicate never silently displaces the record other rows resolve against.
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

function checkReferences(issues: ValidationIssue[], view: DocumentView): void {
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

function collectIssues(input: unknown): ValidationIssue[] {
	const issues: ValidationIssue[] = []

	if (!isPlainObject(input)) {
		add(issues, "$", ValidationIssueCode.WrongType, "a geographic-model document must be an object")

		return issues
	}

	checkFieldNames(issues, "$", input, DOCUMENT_FIELDS)
	readString(issues, "$", input, "version", true)

	checkReferences(issues, {
		relations: readTable(issues, input, "relations", "relation", readRelation),
		concepts: readTable(issues, input, "concepts", "concept", readConcept),
		mappings: readTable(issues, input, "mappings", "mapping", readMapping),
		observations: readTable(issues, input, "observations", "observation", readObservation),
		derivedFacts: readTable(issues, input, "derivedFacts", "derived fact", readDerivedFact),
	})

	return issues
}

/**
 * Validate an authored geographic-model document.
 *
 * Returns the document whole, or every reason it is not one. Issues arrive in traversal order — shape issues per record
 * in table order, then whole-table reference issues — so two runs over the same input produce the same list.
 */
export function validateGeographicModelDocument(input: unknown): ValidationResult {
	const issues = collectIssues(input)

	if (issues.length) return { ok: false, issues }

	// A clean input IS the document — the validator reads, it never rewrites. Keeping the assertion in this function,
	// where `input` is still `unknown`, is what makes it a single step rather than a cast through `unknown`.
	return { ok: true, document: input as GeographicModelDocument }
}

/**
 * Render every issue as one line, `path: message [code]`, in the order the validator produced them.
 */
export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
	return issues.map((issue) => `${issue.path}: ${issue.message} [${issue.code}]`).join("\n")
}

/**
 * Thrown by {@link parseGeographicModelDocument}. Carries the whole issue list, and states the whole issue list in its
 * message, so a caller that only ever prints `error.message` still sees every violation.
 */
export class GeographicModelValidationError extends Error {
	readonly issues: readonly ValidationIssue[]

	constructor(issues: readonly ValidationIssue[]) {
		super(`geographic-model document is invalid (${issues.length} issues)\n${formatValidationIssues(issues)}`)

		this.name = "GeographicModelValidationError"
		this.issues = issues
	}
}

/**
 * Validate and return an authored document, throwing {@link GeographicModelValidationError} with every violation if it
 * does not validate. The throwing form is for callers with no partial-result behavior to offer — a compiler, a build
 * step, a test.
 */
export function parseGeographicModelDocument(input: unknown): GeographicModelDocument {
	const result = validateGeographicModelDocument(input)

	if (!result.ok) throw new GeographicModelValidationError(result.issues)

	return result.document
}
