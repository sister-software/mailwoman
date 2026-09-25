/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines the compiled geographic model artifact, its canonical serialization and its reader.
 *
 *   Runtime consumers read the artifact instead of the authored records. The artifact includes the
 *   materialized `isA` closure so that consumers never traverse `concepts[].isA` at query time.
 *
 *   The serialization is deterministic. Object keys appear in code-point order at every depth, and the
 *   compiler sorts each table by identifier in code-point order. Arrays inside a record keep their
 *   authored order. The artifact records no build time, so two builds of one document are byte-identical.
 */

import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { isPlainObject } from "@mailwoman/core/objects"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"

import type {
	ConceptID,
	ConceptRecord,
	DerivedFactRecord,
	ExternalMappingRecord,
	RelationRecord,
	SourceObservationRecord,
} from "#schema"

/**
 * The artifact format version.
 *
 * Increment it whenever the compiled shape changes, so that a reader rejects
 * an artifact it cannot interpret.
 */
export const ARTIFACT_SCHEMA_VERSION = 1

/**
 * One concept's transitive `isA` ancestors.
 *
 * Every compiled concept has an entry, even with an empty ancestor list,
 * so a missing entry always means an unknown concept.
 */
export interface InheritanceClosureEntry {
	concept: ConceptID
	ancestors: readonly ConceptID[]
}

/**
 * The compiled artifact.
 *
 * The compiler sorts the authored tables without changing any record.
 * It adds the inheritance closure and the derived facts that it computes.
 */
export interface CompiledGeographicModel {
	/**
	 * The format version, equal to {@link ARTIFACT_SCHEMA_VERSION} when the artifact was written.
	 */
	schemaVersion: number
	/**
	 * The authored document's `version`.
	 */
	modelVersion: string
	relations: readonly RelationRecord[]
	concepts: readonly ConceptRecord[]
	mappings: readonly ExternalMappingRecord[]
	observations: readonly SourceObservationRecord[]
	inheritanceClosure: readonly InheritanceClosureEntry[]
	/**
	 * The authored derived facts plus the facts that the compiler derived.
	 *
	 * Each fact records its procedure and every record that the procedure read.
	 */
	derivedFacts: readonly DerivedFactRecord[]
}

/**
 * Copies `value` with object keys in code-point order at every depth and drops `undefined` entries.
 * Arrays keep their order.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize)

	if (!isPlainObject(value)) return value

	const canonical: Record<string, unknown> = {}

	for (const key of Object.keys(value).toSorted(compareByCodePoint)) {
		const entry = value[key]

		if (entry === undefined) continue

		canonical[key] = canonicalize(entry)
	}

	return canonical
}

/**
 * Serializes the artifact as tab-indented JSON with a trailing newline and sorted keys.
 *
 * The committed copy also passes through `oxfmt`, which inlines short arrays.
 * A freshness check therefore compares parsed values, and only a comparison of two compiles compares bytes.
 */
export function serializeCompiledModel(model: CompiledGeographicModel): string {
	return prettyJSON(canonicalize(model))
}

/**
 * Thrown when a value cannot be read as a compiled artifact.
 */
export class GeographicModelArtifactError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "GeographicModelArtifactError"
	}
}

/**
 * The tables that every artifact must contain.
 */
const ARTIFACT_TABLES = [
	"concepts",
	"derivedFacts",
	"inheritanceClosure",
	"mappings",
	"observations",
	"relations",
] as const

/**
 * Returns the reason `value` is not a compiled artifact, or `undefined` when it is one.
 */
function artifactProblem(value: unknown): string | undefined {
	if (!isPlainObject(value)) return "a compiled geographic model must be an object"

	if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
		return `this reader understands artifact schema version ${ARTIFACT_SCHEMA_VERSION}; the artifact declares ${stringifyJSON(value.schemaVersion)}`
	}

	if (typeof value.modelVersion !== "string" || !value.modelVersion.trim().length) {
		return "`modelVersion` must be a non-blank string"
	}

	const missing = ARTIFACT_TABLES.filter((table) => !Array.isArray(value[table]))

	if (!missing.length) return undefined

	return `the artifact is missing ${missing.map((table) => `\`${table}\``).join(", ")}`
}

/**
 * Reads a value from `JSON.parse` as a {@link CompiledGeographicModel}.
 *
 * The reader checks the format version, the model version and the presence of every table.
 * It does not revalidate records, because the compiler accepts only documents
 * that already passed validation.
 */
export function parseCompiledGeographicModel(input: unknown): CompiledGeographicModel {
	const problem = artifactProblem(input)

	if (problem) throw new GeographicModelArtifactError(problem)

	return input as CompiledGeographicModel
}
