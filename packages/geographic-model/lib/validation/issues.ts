/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The issue vocabulary and the primitive field readers `./validate.ts` is built from.
 *
 *   Every reader takes the issue list it appends to and returns `undefined` when it could not read the
 *   field. That shape is deliberate: a reader that threw would end the pass at the first defect, and a
 *   reader that substituted a default would convert "I could not read this" into a value, which at a
 *   validation boundary is the same as inventing one. Returning nothing, having said why, lets the
 *   caller skip the checks that depended on the field and keep running the ones that did not.
 *
 *   `./validate.ts` re-exports {@link ValidationIssueCode} and {@link ValidationIssue}; the readers
 *   stay internal to the package.
 */

/**
 * Every way a document can fail validation. Closed, so a consumer branches on the code rather than on message prose.
 */
export const ValidationIssueCode = {
	MissingField: "missing_field",
	WrongType: "wrong_type",
	/**
	 * A required string was present and blank.
	 */
	EmptyValue: "empty_value",
	/**
	 * A list that must carry entries was empty.
	 */
	EmptyList: "empty_list",
	UnknownField: "unknown_field",
	/**
	 * A field whose name announces ranking policy. Refused wherever it appears, at any depth.
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
	 * A JSONPath-style address into the validated input, e.g. `$.concepts[0].assertions[1].modality`. The document root
	 * is `$`.
	 */
	path: string
	code: ValidationIssueCode
	message: string
}

/**
 * Name fragments that announce ranking policy. Matched case-insensitively against every field name at every depth, so
 * `score`, `boost`, `penalty`, `rankWeight`, `relevanceWeight`, and `affinityWeight` are refused by one rule rather
 * than by an enumeration that a seventh spelling walks past.
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
): string | undefined {
	const value = container[key]
	const fieldPath = `${path}.${key}`

	if (value === undefined) {
		if (required) {
			add(issues, fieldPath, ValidationIssueCode.MissingField, `\`${key}\` is required`)
		}

		return undefined
	}

	if (typeof value !== "string") {
		add(issues, fieldPath, ValidationIssueCode.WrongType, `\`${key}\` must be a string`)

		return undefined
	}

	if (!value.trim().length) {
		add(issues, fieldPath, ValidationIssueCode.EmptyValue, `\`${key}\` must not be blank`)

		return undefined
	}

	return value
}

export function readBoolean(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string
): boolean | undefined {
	const value = container[key]
	const fieldPath = `${path}.${key}`

	if (value === undefined) {
		add(issues, fieldPath, ValidationIssueCode.MissingField, `\`${key}\` is required`)

		return undefined
	}

	if (typeof value !== "boolean") {
		add(issues, fieldPath, ValidationIssueCode.WrongType, `\`${key}\` must be a boolean`)

		return undefined
	}

	return value
}

export function readArray(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	required: boolean
): unknown[] | undefined {
	const value = container[key]
	const fieldPath = `${path}.${key}`

	if (value === undefined) {
		if (required) {
			add(issues, fieldPath, ValidationIssueCode.MissingField, `\`${key}\` is required`)
		}

		return undefined
	}

	if (!Array.isArray(value)) {
		add(issues, fieldPath, ValidationIssueCode.WrongType, `\`${key}\` must be an array`)

		return undefined
	}

	return value
}

export function readStringArray(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	required: boolean
): string[] | undefined {
	const entries = readArray(issues, path, container, key, required)

	if (!entries) return undefined

	const values: string[] = []

	for (const [index, entry] of entries.entries()) {
		const entryPath = `${path}.${key}[${index}]`

		if (typeof entry !== "string") {
			add(issues, entryPath, ValidationIssueCode.WrongType, "must be a string")

			continue
		}

		if (!entry.trim().length) {
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
): T | undefined {
	const value = readString(issues, path, container, key, true)

	if (value === undefined) return undefined

	const match = allowed.find((candidate) => candidate === value)

	if (match === undefined) {
		add(issues, `${path}.${key}`, code, `\`${value}\` is not one of ${listVocabulary(allowed)}`)
	}

	return match
}

export function readVocabularyArray<T extends string>(
	issues: ValidationIssue[],
	path: string,
	container: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
	code: ValidationIssueCode
): T[] | undefined {
	const values = readStringArray(issues, path, container, key, true)

	if (!values) return undefined

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
