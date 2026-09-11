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
	readArray,
	readBoolean,
	readString,
	readStringArray,
	readVocabularyArray,
	readVocabularyValue,
	type ValidationIssue,
	ValidationIssueCode,
} from "#validation-issues"
import { checkReferences } from "#validation-references"

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

export interface AssertionView {
	path: string
	id?: string
	relation?: string
	target?: string
}

export interface ConceptView {
	path: string
	id?: string
	kind?: ConceptKind
	isA?: string[]
	assertions: AssertionView[]
}

export interface RelationView {
	path: string
	id?: string
	domainKinds?: ConceptKind[]
	rangeKinds?: ConceptKind[]
	transitive?: boolean
	symmetric?: boolean
	inverse?: string
}

export interface MappingView {
	path: string
	id?: string
	concept?: string
}

export interface TripleView {
	path: string
	id?: string
	subject?: string
	relation?: string
	object?: string
}

export interface DerivationInputView {
	path: string
	kind?: DerivationInputKind
	id?: string
}

export interface DerivedFactView extends TripleView {
	inputs: DerivationInputView[]
}

export interface DocumentView {
	relations: RelationView[]
	concepts: ConceptView[]
	mappings: MappingView[]
	observations: TripleView[]
	derivedFacts: DerivedFactView[]
}

export interface ReferenceTables {
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
