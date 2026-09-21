/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared machinery for the frozen pre-registrations (#1928, #1965, #1967): the canonical-JSON content
 *   hash, the freeze-record loader that refuses a ruler whose hash has moved, and the artifact-identity
 *   readers every probe receipt carries.
 *
 *   one loader, three rulers. Each pre-registration keeps its own definition type, its own audit and its
 *   own committed JSON, but the refusal ladder is the interface they share: the freeze record must name
 *   this definition and version, the definition's content hash must equal the frozen hash, and the audit
 *   must be clean. A caller never receives a definition it may only partly trust.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { md5File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { resolveWeights } from "@mailwoman/neural/weights"

import { type LayerManifest, probeManifest } from "#data/inventory"
import type { POIBoardResolverBackend } from "#eval-harness/poi/board"

/**
 * A committed pre-registration file, named from the package root because `tsc` emits no `.json` into `out/`.
 */
export function preregistrationPath(directory: string, name: string): string {
	return resolvePackagePath("mailwoman", "lib", "eval-harness", directory, name)
}

/**
 * Canonical JSON for hashing: keys sorted at every depth, array order preserved,
 * no insignificant whitespace.
 *
 * The hash covers content rather than bytes so a formatter pass cannot break the freeze
 * and a reordered key cannot slip past it.
 * Array order is meaningful — row order is reported order — so it is never sorted.
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
 * The content hash of one definition.
 */
export function definitionContentHash(definition: unknown): string {
	return sha256Hex(canonicalJSON(definition))
}

/**
 * The freeze record every pre-registration commits beside its definition:
 * the definition's identity and the content hash that pins it.
 *
 * The identity field's name varies per ruler (`probeID`, `decisionID`),
 * so the loader takes it as a parameter rather than declaring it here.
 */
export interface FrozenDefinitionFreezeRecord {
	definition: string
	version: string
	sha256: string
	frozenAt: string
	note: string
}

export interface LoadFrozenDefinitionOptions<T> {
	definitionPath: string
	freezePath: string
	/**
	 * The prefix on every refusal — `"phase-2 decision"`, `"semantic-utility probe"`, `"absence probe"`.
	 */
	label: string
	/**
	 * The identity field both the definition and the freeze record carry (`"probeID"`, `"decisionID"`).
	 */
	idField: keyof T & string
	/**
	 * The definition's own executability audit.
	 * Any problem refuses the load.
	 */
	audit: (definition: T) => string[]
}

/**
 * Load a frozen pre-registration, refusing anything that would let the ruler move.
 *
 * Three refusals, in order: the freeze record must name this definition and version,
 * the definition's content hash must equal the frozen hash, and the audit must be clean.
 * A caller never receives a definition it may only partly trust.
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
 * The duplicate-id half of a definition audit: ids name rows in output, so a reused one is refused.
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
 * The sampling clauses every stratified pre-registration carries.
 */
export interface SamplingRegistration {
	seed: number
	rowsPerStratum: number
	minimumRowsPerStratum: number
}

/**
 * The sampling half of a definition audit, shared because every stratified ruler
 * registers the same three quantities and each has one way to be unexecutable:
 * a target too small for the power the record will claim, a floor sitting above the
 * target it is a floor for, and a seed the generator cannot take.
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
 * The withheld-fields half of a definition audit: the ruler's list and the fixture type's list must
 * name the same fields, or "equal evidence" means one thing in the record and another in the file.
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
 * The weights half of a receipt's artifact identity.
 */
export interface WeightsIdentity {
	weightsLocale: string
	/**
	 * Md5 of the resolved `model.onnx`, which is what distinguishes two arms.
	 *
	 * A staged candidate's `model-card.json` can be a symlink into the shared data root,
	 * so two caches holding different graphs read the same `weightsVersion`; the bytes never do.
	 */
	weightsModelMD5: string
	weightsModelPath: string
	weightsVersion: string
}

export interface WeightsIdentityOptions {
	locale?: string
	weightsCacheRoot?: string
}

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
 * Which artifacts a probe run read, as its receipt carries them.
 */
export interface PreregisteredArtifactIdentity extends WeightsIdentity {
	poiDatabasePath: string
	/**
	 * The database's own `layer_manifest` row, or the reason it could not be read.
	 *
	 * Never silently absent: an unstamped artifact and an unreadable one are different
	 * findings, and both matter to a reproduction.
	 */
	poiLayerManifest?: LayerManifest
	poiLayerManifestNote?: string
	resolverBackend: POIBoardResolverBackend
}

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
