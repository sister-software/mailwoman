/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The issue vocabulary and the primitive field readers `./validate.ts` is built from.
 *
 * Every reader appends issues to the supplied list and returns `null` when it cannot read a field.
 * The pass records each defect and continues.
 * A default would turn an unreadable field into a value and invent data at the validation boundary.
 */

/**
 * Every way a document can fail validation.
 *
 * The set is closed, so a consumer branches on the code rather than on message prose.
 */
export const ValidationIssueCode = {
	MissingField: "missing_field",
	WrongType: "wrong_type",
	/**
	 * A required string was present and blank.
	 */
	EmptyValue: "empty_value",
	/**
	 * A list that must contain entries was empty.
	 */
	EmptyList: "empty_list",
	UnknownField: "unknown_field",
	/**
	 * A field whose name announces ranking policy, refused wherever it appears at any depth.
	 */
	RankingField: "ranking_field",
	UnknownConceptKind: "unknown_concept_kind",
	UnknownModality: "unknown_modality",
	UnknownRelationSemantics: "unknown_relation_semantics",
	UnknownConceptStatus: "unknown_concept_status",
	UnknownExternalVocabulary: "unknown_external_vocabulary",
	UnknownDerivationInputKind: "unknown_derivation_input_kind",
	DuplicateID: "duplicate_id",
	/**
	 * A record names itself where it may only name another record.
	 */
	SelfReference: "self_reference",
	CyclicIsA: "cyclic_isa",
	UnknownConcept: "unknown_concept",
	UnknownRelation: "unknown_relation",
	UnknownDerivationInput: "unknown_derivation_input",
	DomainKindMismatch: "domain_kind_mismatch",
	RangeKindMismatch: "range_kind_mismatch",
	InverseNotReciprocal: "inverse_not_reciprocal",
	InverseKindsMismatch: "inverse_kinds_mismatch",
	TransitiveKindsDisjoint: "transitive_kinds_disjoint",
	MalformedCountry: "malformed_country",
} as const

export type ValidationIssueCode = (typeof ValidationIssueCode)[keyof typeof ValidationIssueCode]

/**
 * One violation, addressed by where it was found.
 */
export interface ValidationIssue {
	/**
	 * A JSONPath-style address into the validated input whose root is `$`,
	 * e.g. `$.concepts[0].assertions[1].modality`.
	 */
	path: string
	code: ValidationIssueCode
	message: string
}

/**
 * Name fragments that announce ranking policy, matched case-insensitively against every field name
 * at every depth so a new spelling is refused by one rule rather than added to an enumeration.
 */
const RANKING_FIELD_FRAGMENTS = [
	"boost",
	"penalt",
	"weight",
	"rank",
	"score",
	"relevance",
	"affinity",
	"priorit",
	"ordering",
] as const

export function add(issues: ValidationIssue[], path: string, code: ValidationIssueCode, message: string): void {
	issues.push({ path, code, message })
}

export function listVocabulary(allowed: readonly string[]): string {
	return allowed.map((candidate) => `\`${candidate}\``).join(", ")
}

/**
 * Refuse any field the schema does not declare, naming the ranking-policy ones under their own code.
 */
export function checkFieldNames(
	issues: ValidationIssue[],
	path: string,
	value: Record<string, unknown>,
	allowed: readonly string[]
): void {
	for (const key of Object.keys(value)) {
		const lowered = key.toLowerCase()
		const fragment = RANKING_FIELD_FRAGMENTS.find((candidate) => lowered.includes(candidate))

		if (fragment) {
			add(
				issues,
				`${path}.${key}`,
				ValidationIssueCode.RankingField,
				`field \`${key}\` names ranking policy (\`${fragment}\`) — authored records create observations, and ranking belongs to @mailwoman/resolver and @mailwoman/neural`
			)

			continue
		}

		if (!allowed.includes(key)) {
			add(
				issues,
				`${path}.${key}`,
				ValidationIssueCode.UnknownField,
				`unknown field \`${key}\` — this record accepts ${listVocabulary(allowed)}`
			)
		}
	}
}

export function readString(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	required: boolean
): string | null {
	const value = container[key]
	const fieldPath = `${path}.${key}`

	if (value === undefined) {
		if (required) {
			add(issues, fieldPath, ValidationIssueCode.MissingField, `\`${key}\` is required`)
		}

		return null
	}

	if (typeof value !== "string") {
		add(issues, fieldPath, ValidationIssueCode.WrongType, `\`${key}\` must be a string`)

		return null
	}

	if (!value.trim()) {
		add(issues, fieldPath, ValidationIssueCode.EmptyValue, `\`${key}\` must not be blank`)

		return null
	}

	return value
}

export function readBoolean(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string
): boolean | null {
	const value = container[key]
	const fieldPath = `${path}.${key}`

	if (value === undefined) {
		add(issues, fieldPath, ValidationIssueCode.MissingField, `\`${key}\` is required`)

		return null
	}

	if (typeof value !== "boolean") {
		add(issues, fieldPath, ValidationIssueCode.WrongType, `\`${key}\` must be a boolean`)

		return null
	}

	return value
}

export function readArray(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	required: boolean
): unknown[] | null {
	const value = container[key]
	const fieldPath = `${path}.${key}`

	if (value === undefined) {
		if (required) {
			add(issues, fieldPath, ValidationIssueCode.MissingField, `\`${key}\` is required`)
		}

		return null
	}

	if (!Array.isArray(value)) {
		add(issues, fieldPath, ValidationIssueCode.WrongType, `\`${key}\` must be an array`)

		return null
	}

	return value
}

export function readStringArray(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	required: boolean
): string[] | null {
	const entries = readArray(issues, path, container, key, required)

	if (!entries) return null

	const values: string[] = []

	for (const [index, entry] of entries.entries()) {
		const entryPath = `${path}.${key}[${index}]`

		if (typeof entry !== "string") {
			add(issues, entryPath, ValidationIssueCode.WrongType, "must be a string")

			continue
		}

		if (!entry.trim()) {
			add(issues, entryPath, ValidationIssueCode.EmptyValue, "must not be blank")

			continue
		}

		values.push(entry)
	}

	return values
}

export function readVocabularyValue<T extends string>(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	code: ValidationIssueCode
): T | null {
	const value = readString(issues, path, container, key, true)

	if (!value) return null

	const match = allowed.find((candidate) => candidate === value)

	if (match === undefined) {
		add(issues, `${path}.${key}`, code, `\`${value}\` is not one of ${listVocabulary(allowed)}`)
	}

	return match ?? null
}

export function readVocabularyArray<T extends string>(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	code: ValidationIssueCode
): T[] | null {
	const values = readStringArray(issues, path, container, key, true)

	if (!values) return null

	const matched: T[] = []

	for (const [index, value] of values.entries()) {
		const match = allowed.find((candidate) => candidate === value)

		if (match === undefined) {
			add(issues, `${path}.${key}[${index}]`, code, `\`${value}\` is not one of ${listVocabulary(allowed)}`)

			continue
		}

		matched.push(match)
	}

	return matched
}
