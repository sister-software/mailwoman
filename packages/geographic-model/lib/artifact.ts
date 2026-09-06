/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The compiled runtime artifact: its shape, its canonical bytes, and the reader that turns those
 *   bytes back into a typed value.
 *
 *   A runtime consumer reads THIS and never the authored records. That is the whole point of the
 *   artifact, and it is why the shape carries every table plus the materialized `isA` closure: a
 *   consumer that had to walk `concepts[].isA` to answer a question about one concept would be doing
 *   query-time traversal, which the boundary record excludes.
 *
 *   Two determinism rules define the bytes, and both are stated so a reader can check them:
 *
 *   1. **Every object's keys are emitted in code-point order**, at every depth. A rule that
 *      canonicalizes by itself beats a hand-kept field order, which drifts the first time the schema
 *      gains a field.
 *   2. **Every table is ordered by identifier**, under {@link compareIdentifiers} — code point, never
 *      `localeCompare`, whose answer depends on the machine's collation. Arrays INSIDE a record keep
 *      the order they were authored in; the compiler writes the tables, so it orders those.
 *
 *   Nothing here records when compilation ran. `modelVersion` is the authored document's own version,
 *   so two builds of one document are byte-identical, and a clock in the artifact would make every
 *   regenerate a diff.
 *
 *   Boundary record: `docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md` (#1917).
 */

import { prettyJSON } from "@mailwoman/core/json"
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
 * The artifact FORMAT version — incremented by hand when the compiled shape changes, so a reader meeting an artifact it
 * was not written for says so instead of quietly reading fields that moved.
 *
 * It is not data about the world, which is why a number is allowed here and nowhere in `./schema.ts`.
 */
export const ARTIFACT_SCHEMA_VERSION = 1

/**
 * One concept's transitive `isA` ancestors, materialized so a consumer answers "what is this a kind of" with a lookup.
 *
 * Every concept gets an entry, including one with no ancestors at all: an entry with an empty list says the concept was
 * compiled and is a kind of nothing, and a missing entry would say the same thing while also being what an absent
 * concept looks like.
 */
export interface InheritanceClosureEntry {
	concept: ConceptID
	ancestors: readonly ConceptID[]
}

/**
 * The whole compiled artifact.
 *
 * The five authored tables travel unchanged — the compiler orders them and rewrites no record — beside the two tables
 * it computes: {@link InheritanceClosureEntry} per concept, and the derived facts the closure materializes.
 */
export interface CompiledGeographicModel {
	/**
	 * The format version of this artifact — {@link ARTIFACT_SCHEMA_VERSION} at the time it was written.
	 */
	schemaVersion: number
	/**
	 * The authored document's own `version`. Never a build date.
	 */
	modelVersion: string
	relations: readonly RelationRecord[]
	concepts: readonly ConceptRecord[]
	mappings: readonly ExternalMappingRecord[]
	observations: readonly SourceObservationRecord[]
	inheritanceClosure: readonly InheritanceClosureEntry[]
	/**
	 * The authored derived facts, plus every fact the compiler's derivations produced. Each names the procedure that
	 * wrote it and every record that procedure read.
	 */
	derivedFacts: readonly DerivedFactRecord[]
}

/**
 * The artifact's stated order: UTF-16 code point, ascending.
 *
 * `String.prototype.localeCompare` is the trap this exists to avoid — its answer depends on the machine's collation, so
 * an artifact ordered with it is reproducible only on the machine that built it.
 */

/**
 * Rebuild `value` with every object's keys in code-point order, at every depth. Arrays keep their order — ordering
 * those is the compiler's job, and doing it here would silently reorder authored data.
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
 * The artifact's canonical bytes: tab-indented, one trailing newline, keys in code-point order.
 *
 * Tab indentation and the trailing newline match the repository's other committed JSON tables (`taxonomy.json`,
 * `brands.json`). A committed copy of these bytes is the generator's output run through `oxfmt`, which inlines short
 * arrays — so a freshness check compares the PARSED artifact against a fresh compile, and a byte comparison compares
 * two compiles.
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
 * The tables every artifact carries. A reader that finds one missing refuses rather than answering every question about
 * that table with an empty list.
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
 * Why `value` is not a compiled artifact, or nothing when it is one.
 *
 * Kept separate from {@link parseCompiledGeographicModel} so the reader casts the value it was HANDED, still typed
 * `unknown`, rather than a narrowed shape it would have to launder through a second cast to widen again.
 */
function artifactProblem(value: unknown): string | undefined {
	if (!isPlainObject(value)) return "a compiled geographic model must be an object"

	if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
		return `this reader understands artifact schema version ${ARTIFACT_SCHEMA_VERSION}; the artifact declares ${JSON.stringify(value.schemaVersion)}`
	}

	if (typeof value.modelVersion !== "string" || !value.modelVersion.trim().length) {
		return "`modelVersion` must be a non-blank string"
	}

	const missing = ARTIFACT_TABLES.filter((table) => !Array.isArray(value[table]))

	if (!missing.length) return undefined

	return `the artifact is missing ${missing.map((table) => `\`${table}\``).join(", ")}`
}

/**
 * Read a parsed artifact — the value `JSON.parse` produced from the compiled bytes — as a
 * {@link CompiledGeographicModel}.
 *
 * It checks the format version and the presence of every table, and does NOT re-validate the records. An artifact is
 * generated from a document that `parseGeographicModelDocument` already accepted; re-checking every record here would
 * be a second validator, and the version check is what catches the failure this reader can actually meet — an artifact
 * written by a different compiler.
 */
export function parseCompiledGeographicModel(input: unknown): CompiledGeographicModel {
	const problem = artifactProblem(input)

	if (problem) throw new GeographicModelArtifactError(problem)

	return input as CompiledGeographicModel
}
