/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared hashing, loading, audit, and artifact-identity helpers for frozen pre-registrations.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { md5File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { resolveWeights } from "@mailwoman/neural/weights"
import type { PathBuilderLike } from "path-ts"

import { type LayerManifest, probeManifest } from "#data/inventory"
import type { POIBoardResolverBackend } from "#eval-harness/poi/board"

/**
 * Resolves a committed pre-registration file from the package root.
 *
 * The path starts at the package root because `tsc` does not copy `.json` files into `out/`.
 */
export function preregistrationPath(directory: string, name: string): string {
	return resolvePackagePath("mailwoman", "lib", "eval-harness", directory, name)
}

/**
 * Serializes a value as canonical JSON for hashing.
 *
 * Object keys are sorted at every depth and `undefined` entries are dropped,
 * so reformatting the file does not change the hash.
 * Array order is preserved because row order is reported order.
 */
export function canonicalJSON(value: unknown): string {
	if (value === null || typeof value !== "object") return stringifyJSON(value) ?? "null"

	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== undefined)
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

	return `{${entries.map(([key, entryValue]) => `${stringifyJSON(key)}:${canonicalJSON(entryValue)}`).join(",")}}`
}

/**
 * Returns the SHA-256 of a definition's canonical JSON.
 */
export function definitionContentHash(definition: unknown): string {
	return sha256Hex(canonicalJSON(definition))
}

/**
 * The freeze record committed beside a pre-registration definition.
 *
 * The record also holds an identity field whose name varies per definition,
 * such as `probeID` or `decisionID`.
 * The loader receives that name through `idField`.
 */
export interface FrozenDefinitionFreezeRecord {
	definition: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

/**
 * Options for {@link loadFrozenDefinition}.
 */
export interface LoadFrozenDefinitionOptions<T> {
	definitionPath: PathBuilderLike
	freezePath: PathBuilderLike
	/**
	 * The prefix on every error message, such as `"semantic-utility probe"`.
	 */
	label: string
	/**
	 * The identity field that both the definition and the freeze record carry, such as `"probeID"`.
	 */
	idField: keyof T & string
	/**
	 * Returns the definition's problems.
	 * Any problem fails the load.
	 */
	audit: (definition: T) => string[]
}

/**
 * Loads a frozen pre-registration definition.
 *
 * The load throws when the freeze record's identity or version differs from the definition,
 * when the definition's content hash differs from the frozen hash, or when the audit reports a problem.
 */
export async function loadFrozenDefinition<T extends { version: string }>(
	options: LoadFrozenDefinitionOptions<T>
): Promise<T> {
	const { definitionPath, freezePath, label, idField, audit } = options
	const definition = await readLocalJSONFile<T>(definitionPath)
	const freeze = await readLocalJSONFile<FrozenDefinitionFreezeRecord & Record<string, string>>(freezePath)
	const noun = idField.replace(/ID$/, "")
	const definitionID = String(definition[idField])

	if (freeze[idField] !== definitionID) {
		throw new Error(
			`${label}: freeze record names ${noun} ${stringifyJSON(freeze[idField])}, definition is ${stringifyJSON(definitionID)}`
		)
	}

	if (freeze.version !== definition.version) {
		throw new Error(
			`${label}: freeze record pins version ${freeze.version}, definition is ${definition.version} — a definition change bumps BOTH the version and the hash`
		)
	}

	const observed = definitionContentHash(definition)

	if (observed !== freeze.sha256) {
		throw new Error(
			`${label}: definition content hash ${observed} !== frozen ${freeze.sha256} — the ruler moved. Restore it, or record a new version and hash in ${freeze.definition}`
		)
	}

	const problems = audit(definition)

	if (problems.length) {
		throw new Error(
			[`${label}: the pre-registration is not executable:`, ...problems.map((problem) => `  - ${problem}`)].join("\n")
		)
	}

	return definition
}

/**
 * Reports each row ID used more than once, because the output identifies rows by ID.
 */
export function duplicateRowIDProblems(rows: ReadonlyArray<{ id: string }>): string[] {
	const problems: string[] = []
	const seen = new Set<string>()

	for (const row of rows) {
		if (seen.has(row.id)) {
			problems.push(`row id ${stringifyJSON(row.id)} is used twice — ids name rows in output`)
		}

		seen.add(row.id)
	}

	return problems
}

/**
 * The sampling settings of a stratified pre-registration.
 */
export interface SamplingRegistration {
	seed: number
	rowsPerStratum: number
	minimumRowsPerStratum: number
}

/**
 * Audits sampling settings.
 *
 * It reports a per-stratum target below `minimumTarget`, a minimum above the target,
 * and a seed that is not an integer.
 */
export function samplingProblems(sampling: SamplingRegistration, minimumTarget: number): string[] {
	const problems: string[] = []

	if (sampling.rowsPerStratum < minimumTarget) {
		problems.push(
			`rowsPerStratum is ${sampling.rowsPerStratum} — the registered power arithmetic needs at least ${minimumTarget}`
		)
	}

	if (sampling.minimumRowsPerStratum > sampling.rowsPerStratum) {
		problems.push(
			`minimumRowsPerStratum ${sampling.minimumRowsPerStratum} exceeds the target ${sampling.rowsPerStratum} — the floor cannot sit above the target it is a floor for`
		)
	}

	if (!Number.isInteger(sampling.seed)) {
		problems.push("the sampling seed is not an integer — mulberry32 takes an integer stream position")
	}

	return problems
}

/**
 * Reports a problem when the registered withheld fields differ from the fields the fixture type withholds.
 */
export function withheldFieldProblems(registered: readonly string[], enforced: readonly string[]): string[] {
	const left = [...registered].toSorted(compareByCodePoint).join(",")
	const right = [...enforced].toSorted(compareByCodePoint).join(",")

	if (left === right) return []

	return [
		`the ruler withholds ${left} and the fixture type withholds ${right} — the two must name the same fields, or "equal evidence" means one thing in the record and another in the file`,
	]
}

interface ModelCard {
	version: string
}

/**
 * Identifies the model weights a run used.
 */
export interface WeightsIdentity {
	weightsLocale: string
	/**
	 * MD5 of the resolved `model.onnx`.
	 *
	 * Two caches can report the same `weightsVersion` for different graphs, because a
	 * staged `model-card.json` can be a symlink into the shared data root.
	 * The hash tells them apart.
	 */
	weightsModelMD5: string
	weightsModelPath: string
	weightsVersion: string
}

/**
 * Options for resolving the weights a run uses.
 */
export interface WeightsIdentityOptions {
	locale?: string
	weightsCacheRoot?: string
}

/**
 * Resolves the weights for a locale and reads their identity.
 * The locale defaults to `en-US`.
 */
export async function readWeightsIdentity(options: WeightsIdentityOptions): Promise<WeightsIdentity> {
	const locale = options.locale ?? "en-US"
	const resolved = await resolveWeights({ locale, cacheRoot: options.weightsCacheRoot })
	const cardPath = resolved.modelCardPath ?? resolved.baseModelCardPath
	const weightsModelMD5 = await md5File(resolved.modelPath)

	if (!cardPath) {
		return {
			weightsLocale: locale,
			weightsModelMD5,
			weightsModelPath: resolved.modelPath,
			weightsVersion: "no model-card resolved",
		}
	}

	const card = await readLocalJSONFile<ModelCard>(cardPath)

	return { weightsLocale: locale, weightsModelMD5, weightsModelPath: resolved.modelPath, weightsVersion: card.version }
}

/**
 * The artifacts a probe run read, as recorded in its receipt.
 */
export interface PreregisteredArtifactIdentity extends WeightsIdentity {
	poiDatabasePath: string
	/**
	 * The database's `layer_manifest` row.
	 * When it is missing, `poiLayerManifestNote` says why.
	 */
	poiLayerManifest?: LayerManifest
	poiLayerManifestNote?: string
	resolverBackend: POIBoardResolverBackend
}

/**
 * Reads the POI database manifest and weights identity for a probe receipt.
 */
export async function readArtifactIdentity(
	db: string,
	backend: POIBoardResolverBackend,
	options: WeightsIdentityOptions
): Promise<PreregisteredArtifactIdentity> {
	const probed = probeManifest(db)

	return {
		poiDatabasePath: db,
		...(probed.manifest ? { poiLayerManifest: probed.manifest } : {}),
		...(probed.manifest
			? {}
			: { poiLayerManifestNote: probed.error ?? "the database carries no layer_manifest table" }),
		resolverBackend: backend,
		...(await readWeightsIdentity(options)),
	}
}
