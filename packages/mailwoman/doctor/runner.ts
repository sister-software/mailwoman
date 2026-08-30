/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The IO half of `mailwoman doctor`: gather the environment facts (weights resolution, data-root
 *   writability, gazetteer discovery, POI manifest, Node + ONNX runtime) and hand them to the pure
 *   verdict logic in {@link ./checks.ts}. All the environment-dependent seams (`fs`, env, dynamic
 *   imports, DB reads) live behind {@link DoctorDeps} so the whole flow is injectable — a test drives
 *   `runDoctor` with fakes, and the default deps wire the real thing. Mirrors, never re-implements:
 *   weights resolution comes from `@mailwoman/neural/weights`, the data root from
 *   `@mailwoman/core/utils`, gazetteer discovery from the same candidate-first order `mailwoman
 *   geocode` uses, and the POI path from `gazetteer build poi`'s own default.
 */

import { $public, DefaultMailwomanPaths } from "@mailwoman/core/env"
import { readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { resolveWeights, weightsPackageName } from "@mailwoman/neural/weights"
import { accessSync, constants, existsSync, readFileSync, statSync } from "@mailwoman/platform/fs"
import { fileURLToPath } from "@mailwoman/platform/url"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"

import { conventionCandidateDBPath, resolveCandidateDBPath, resolveWOFShardPaths } from "../resolver-backend.ts"
import {
	assembleReport,
	checkPOI,
	dataRootCheck,
	gazetteerCheck,
	localeOverlayCheck,
	nodeVersionCheck,
	onnxRuntimeCheck,
	weightsCheck,
	type DoctorCheck,
	type DoctorReport,
	type GazetteerObservation,
	type POIObservation,
	type WeightsObservation,
} from "./checks.ts"

/**
 * The resolved-weights shape the runner needs — a structural subset of `@mailwoman/neural`'s `ResolvedWeights`.
 */
interface ResolvedWeightsLike {
	source: string
	modelPath: string
	tokenizerPath: string
}

/**
 * Every environment seam `runDoctor` touches. Injected in tests; {@link defaultDoctorDeps} wires the real ones.
 */
export interface DoctorDeps {
	/**
	 * File-existence probe.
	 */
	existsSync(path: string): boolean
	/**
	 * Byte size of a file, or `undefined` when it can't be stat'd.
	 */
	fileSize(path: string): number | undefined
	/**
	 * Whether a path is writable (W_OK).
	 */
	isWritable(path: string): boolean
	/**
	 * Resolve a locale's weights package (throws when unresolvable) — mirrors `@mailwoman/neural`.
	 */
	resolveWeights(locale: string): ResolvedWeightsLike
	/**
	 * The npm package name for a locale's weights (e.g. `@mailwoman/neural-weights-fr-fr`).
	 */
	weightsPackageName(locale: string): string
	/**
	 * The resolved data root (blessed helper) + whether it came from the env.
	 */
	dataRoot(): { path: string; fromEnv: boolean }
	/**
	 * The candidate.db the TOOLS would actually use — `resolveCandidateDBPath` (explicit ?? `$MAILWOMAN_CANDIDATE_DB`),
	 * on disk. NO convention-path fallback: that's exactly what geocode/serve do.
	 */
	envCandidatePath(): string | undefined
	/**
	 * The `<data-root>/wof/candidate.db` convention path IF it exists on disk — used to detect the env-unset trap.
	 */
	conventionCandidatePath(): string | undefined
	/**
	 * The WOF admin shard paths to probe ($MAILWOMAN_WOF_DB split, else the default shard set).
	 */
	wofShardPaths(): string[]
	/**
	 * The default POI layer path (`gazetteer build poi`'s own default).
	 */
	poiPath(): string
	/**
	 * Read + validate a POI layer manifest (throws on a missing/invalid manifest).
	 */
	readPOIManifest(path: string): Promise<{ name: string; version: string; sourceVintage: string }>
	/**
	 * Attempt to load the ONNX native binding (throws when unavailable).
	 */
	loadONNX(): Promise<void>
	/**
	 * The running Node version (`process.versions.node`).
	 */
	nodeVersion: string
	/**
	 * The `engines.node` floor from mailwoman's package.json.
	 */
	enginesFloor: string
	/**
	 * The optional locale overlays to report (informational).
	 */
	overlayLocales: string[]
}

/**
 * Read `engines.node` from mailwoman's own package.json, defaulting to `">=0"` if unreadable.
 *
 * Located by SELF-REFERENCE through the package's own `exports` map (`"./package.json": "./package.json"`), so this
 * finds the right manifest from the source tree, the compiled `out/` tree and an installed tarball alike — none of the
 * `__isCompiledTree` distance arithmetic `core/utils/repo.ts` needs. `import.meta.resolve` rather than a static `with {
 * type: "json" }` import (the form `photon/app.ts` and friends use) because the tolerant fallback is the point:
 * `mailwoman doctor` exists to report a broken environment, so an unresolvable manifest must degrade to `">=0"`, not
 * throw at module load.
 */
function readEnginesFloor(): string {
	try {
		const pkg = parseJSONStrict<{ engines?: { node?: string } }>(
			readFileSync(fileURLToPath(import.meta.resolve("mailwoman/package.json")), "utf8")
		)

		return pkg.engines?.node ?? ">=0"
	} catch {
		return ">=0"
	}
}

/**
 * The `<data-root>/wof/candidate.db` convention path if it exists on disk — the file a fresh consumer downloads.
 */
function defaultConventionCandidatePath(dataRoot: string): string | undefined {
	if ($public.MAILWOMAN_CANDIDATE_DB === "none") return undefined

	const convention = conventionCandidateDBPath(dataRoot)

	return existsSync(convention) ? convention : undefined
}

/**
 * Open a POI db READ-ONLY, read its layer manifest, and narrow it to the identity fields doctor prints.
 */
async function readPOIManifest(path: string): Promise<{ name: string; version: string; sourceVintage: string }> {
	using kdb = new DatabaseClient<LayerContractDatabase>(path, { readOnly: true })

	const manifest = await readLayerManifest(kdb)

	return { name: manifest.name, version: manifest.version, sourceVintage: manifest.sourceVintage }
}

/**
 * The production seams — the real filesystem, env, weights resolver, and dynamic imports.
 */
export function defaultDoctorDeps(): DoctorDeps {
	const dataRoot = mailwomanDataRoot()

	return {
		existsSync,
		fileSize: (path) => {
			try {
				return statSync(path).size
			} catch {
				return undefined
			}
		},
		isWritable: (path) => {
			try {
				accessSync(path, constants.W_OK)

				return true
			} catch {
				return false
			}
		},
		resolveWeights: (locale) => resolveWeights({ locale }),
		weightsPackageName,
		dataRoot: () => ({ path: dataRoot, fromEnv: dataRoot !== DefaultMailwomanPaths.data }),
		envCandidatePath: () => ($public.MAILWOMAN_CANDIDATE_DB ? resolveCandidateDBPath(undefined, dataRoot) : undefined),
		conventionCandidatePath: () => defaultConventionCandidatePath(dataRoot),
		wofShardPaths: () => resolveWOFShardPaths(undefined, dataRoot),
		poiPath: () => resolvePath(dataRoot, "poi", "poi.db"),
		readPOIManifest,
		loadONNX: async () => {
			await import("onnxruntime-node")
		},
		nodeVersion: process.versions.node,
		enginesFloor: readEnginesFloor(),
		overlayLocales: ["fr-fr"],
	}
}

// MARK: Fact gathering → checks

function gatherWeights(deps: DoctorDeps): WeightsObservation {
	try {
		const resolved = deps.resolveWeights("en-us")

		return {
			resolved,
			modelSize: deps.fileSize(resolved.modelPath),
			tokenizerSize: deps.fileSize(resolved.tokenizerPath),
		}
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

function gatherGazetteer(deps: DoctorDeps): GazetteerObservation {
	// Same precedence the tools apply: explicit/env candidate.db → convention-path candidate.db → WOF FTS shards.
	// The convention probe must come BEFORE the shards, or a machine holding both reports the FTS shard while every
	// tool on it uses the candidate table — doctor's one job is to name the backend actually in use.
	const envCandidate = deps.envCandidatePath()

	if (envCandidate) {
		return { envCandidate: { path: envCandidate, sizeBytes: deps.fileSize(envCandidate) }, probed: [envCandidate] }
	}

	const convention = deps.conventionCandidatePath()
	const shards = deps.wofShardPaths()

	if (convention) {
		return { conventionCandidate: convention, probed: [convention, ...shards] }
	}

	const existing = shards.find((p) => deps.existsSync(p))

	if (existing) {
		return { wofShard: { path: existing, sizeBytes: deps.fileSize(existing) }, probed: shards }
	}

	return { probed: shards }
}

async function gatherPOI(deps: DoctorDeps): Promise<POIObservation> {
	const path = deps.poiPath()

	if (!deps.existsSync(path)) return { path, exists: false }

	try {
		return { path, exists: true, manifest: await deps.readPOIManifest(path) }
	} catch (error) {
		return { path, exists: true, error: error instanceof Error ? error.message : String(error) }
	}
}

function gatherOverlay(deps: DoctorDeps, locale: string): DoctorCheck {
	const packageName = deps.weightsPackageName(locale)

	try {
		const resolved = deps.resolveWeights(locale)

		return localeOverlayCheck({ locale, packageName, resolved: true, source: resolved.source })
	} catch {
		return localeOverlayCheck({ locale, packageName, resolved: false })
	}
}

/**
 * Run every diagnostic and assemble the report. The check ORDER is the render order, and it is RUNTIME FIRST (#1577):
 * node version, then the ONNX binding, then the model weights, then the optional data layers, then the informational
 * locale overlays.
 *
 * The order is a reading order, not an importance ranking. A stale node or an unloadable native binding explains every
 * other symptom in the report — a reader who sees "weights ok" first and stops has learned nothing, because ok weights
 * on a runtime that cannot run them still parse nothing. Pure verdict logic lives in {@link ./checks.ts}; this only
 * gathers the facts through the injected {@link DoctorDeps}.
 */
export async function runDoctor(overrides?: Partial<DoctorDeps>): Promise<DoctorReport> {
	const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides }

	// Core: weights + runtime.
	const weights = weightsCheck(gatherWeights(deps))
	const nodeCheck = nodeVersionCheck({ nodeVersion: deps.nodeVersion, enginesFloor: deps.enginesFloor })

	let onnxLoadable = false
	let onnxError: string | undefined

	try {
		await deps.loadONNX()
		onnxLoadable = true
	} catch (error) {
		onnxError = error instanceof Error ? error.message : String(error)
	}

	const onnx = onnxRuntimeCheck({ loadable: onnxLoadable, error: onnxError })

	// Optional data layers.
	const root = deps.dataRoot()

	const dataRoot = dataRootCheck({
		path: root.path,
		exists: deps.existsSync(root.path),
		writable: deps.isWritable(root.path),
		fromEnv: root.fromEnv,
	})

	const gazetteer = gazetteerCheck(gatherGazetteer(deps))
	const poi = checkPOI(await gatherPOI(deps))

	// Informational: locale overlays.
	const overlays = deps.overlayLocales.map((locale) => gatherOverlay(deps, locale))

	return assembleReport([nodeCheck, onnx, weights, dataRoot, gazetteer, poi, ...overlays])
}

//#region --verbose environment dump

/**
 * One resolved setting in the `--verbose` dump.
 */
export interface EnvironmentEntry {
	key: string
	/**
	 * The resolved value, or `undefined` when the variable is unset / the path unresolvable. `undefined` is rendered as
	 * `(unset)` rather than omitted — the whole point of the dump is to distinguish "set to something surprising" from
	 * "never set", and a missing row answers neither.
	 */
	value: string | undefined
	/**
	 * Where the value came from, when that is not obvious from the key (`env` vs `default` vs `derived`).
	 */
	source?: string
}

/**
 * Every path and variable the checks above resolved, for `mailwoman doctor --verbose` (#1577).
 *
 * Reads through the SAME {@link DoctorDeps} the checks do, so the dump can never disagree with the verdicts printed
 * above it — that disagreement is exactly the bug a verbose mode exists to catch (a reader who exported
 * `$MAILWOMAN_DATA_ROOT` in one shell and ran the CLI in another).
 */
export function describeEnvironment(overrides?: Partial<DoctorDeps>): EnvironmentEntry[] {
	const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides }
	const root = deps.dataRoot()

	const entries: EnvironmentEntry[] = [
		{ key: "node", value: `v${deps.nodeVersion}`, source: `engines ${deps.enginesFloor}` },
		{ key: "platform", value: `${process.platform}-${process.arch}` },
		{ key: "MAILWOMAN_DATA_ROOT", value: $public.MAILWOMAN_DATA_ROOT, source: root.fromEnv ? "env" : "unset" },
		{ key: "data root (resolved)", value: root.path, source: root.fromEnv ? "env" : "default" },
		{ key: "MAILWOMAN_CANDIDATE_DB", value: $public.MAILWOMAN_CANDIDATE_DB, source: "env" },
		{ key: "candidate.db (convention)", value: deps.conventionCandidatePath(), source: "derived" },
		{ key: "MAILWOMAN_WOF_DB", value: $public.MAILWOMAN_WOF_DB, source: "env" },
		{ key: "POI layer", value: deps.poiPath(), source: "derived" },
	]

	for (const [index, shard] of deps.wofShardPaths().entries()) {
		entries.push({
			key: `WOF shard [${index}]`,
			value: shard,
			source: deps.existsSync(shard) ? "on disk" : "absent",
		})
	}

	try {
		const resolved = deps.resolveWeights("en-us")

		entries.push(
			{ key: "weights model.onnx", value: resolved.modelPath, source: resolved.source },
			{ key: "weights tokenizer.model", value: resolved.tokenizerPath, source: resolved.source }
		)
	} catch (error) {
		entries.push({
			key: "weights",
			value: undefined,
			source: `unresolvable: ${error instanceof Error ? error.message : String(error)}`,
		})
	}

	return entries
}

//#endregion
