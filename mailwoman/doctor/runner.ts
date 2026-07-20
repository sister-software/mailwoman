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

import { accessSync, constants, existsSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { DatabaseSync } from "node:sqlite"

import { $public } from "@mailwoman/core/env"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { dataRootPath, mailwomanDataRoot, wofShardPaths } from "@mailwoman/core/utils"
import { resolveWeights, weightsPackageName } from "@mailwoman/neural/weights"

import {
	assembleReport,
	dataRootCheck,
	gazetteerCheck,
	localeOverlayCheck,
	nodeVersionCheck,
	onnxRuntimeCheck,
	poiCheck,
	weightsCheck,
	type DoctorCheck,
	type DoctorReport,
	type GazetteerObservation,
	type PoiObservation,
	type WeightsObservation,
} from "./checks.ts"

const req = createRequire(import.meta.url)

/** The resolved-weights shape the runner needs — a structural subset of `@mailwoman/neural`'s `ResolvedWeights`. */
interface ResolvedWeightsLike {
	source: string
	modelPath: string
	tokenizerPath: string
}

/** Every environment seam `runDoctor` touches. Injected in tests; {@link defaultDoctorDeps} wires the real ones. */
export interface DoctorDeps {
	/** File-existence probe. */
	existsSync(path: string): boolean
	/** Byte size of a file, or `undefined` when it can't be stat'd. */
	fileSize(path: string): number | undefined
	/** Whether a path is writable (W_OK). */
	isWritable(path: string): boolean
	/** Resolve a locale's weights package (throws when unresolvable) — mirrors `@mailwoman/neural`. */
	resolveWeights(locale: string): ResolvedWeightsLike
	/** The npm package name for a locale's weights (e.g. `@mailwoman/neural-weights-fr-fr`). */
	weightsPackageName(locale: string): string
	/** The resolved data root (blessed helper) + whether it came from the env. */
	dataRoot(): { path: string; fromEnv: boolean }
	/**
	 * The configured candidate.db path if it exists ($MAILWOMAN_CANDIDATE_DB then the `<root>/wof/candidate.db`
	 * convention).
	 */
	candidatePath(): string | undefined
	/** The WOF admin shard paths to probe ($MAILWOMAN_WOF_DB split, else the default shard set). */
	wofShardPaths(): string[]
	/** The default POI layer path (`gazetteer build poi`'s own default). */
	poiPath(): string
	/** Read + validate a POI layer manifest (throws on a missing/invalid manifest). */
	readPoiManifest(path: string): Promise<{ name: string; version: string; sourceVintage: string }>
	/** Attempt to load the ONNX native binding (throws when unavailable). */
	loadOnnx(): Promise<void>
	/** The running Node version (`process.versions.node`). */
	nodeVersion: string
	/** The `engines.node` floor from mailwoman's package.json. */
	enginesFloor: string
	/** The optional locale overlays to report (informational). */
	overlayLocales: string[]
}

/** Read `engines.node` from mailwoman's own package.json (self-reference export), defaulting to `">=0"` if unreadable. */
function readEnginesFloor(): string {
	try {
		const pkg = req("mailwoman/package.json") as { engines?: { node?: string } }

		return pkg.engines?.node ?? ">=0"
	} catch {
		return ">=0"
	}
}

/**
 * The candidate.db discovery order `mailwoman geocode` / `mailwoman serve` use: an explicit `$MAILWOMAN_CANDIDATE_DB`
 * first, then the `<data-root>/wof/candidate.db` convention path that `serve` auto-detects. Returns the first that
 * exists, else `undefined`.
 */
function defaultCandidatePath(): string | undefined {
	const env = $public.MAILWOMAN_CANDIDATE_DB

	if (env && existsSync(env)) return env
	const convention = dataRootPath("wof", "candidate.db")

	return existsSync(convention) ? convention : undefined
}

/** The WOF admin shard set to probe: `$MAILWOMAN_WOF_DB` (comma-split) when set, else the default shard list. */
function defaultWOFShardPaths(): string[] {
	const raw = $public.MAILWOMAN_WOF_DB

	if (raw) {
		return raw
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)
	}

	return wofShardPaths()
}

/** Open a POI db READ-ONLY, read its layer manifest, and narrow it to the identity fields doctor prints. */
async function readPoiManifest(path: string): Promise<{ name: string; version: string; sourceVintage: string }> {
	const raw = new DatabaseSync(path, { readOnly: true })
	const kdb = new DatabaseClient<LayerContractDatabase>({ database: raw })

	try {
		const manifest = await readLayerManifest(kdb)

		return { name: manifest.name, version: manifest.version, sourceVintage: manifest.sourceVintage }
	} finally {
		await kdb.destroy()
	}
}

/** The production seams — the real filesystem, env, weights resolver, and dynamic imports. */
export function defaultDoctorDeps(): DoctorDeps {
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
		dataRoot: () => ({ path: mailwomanDataRoot(), fromEnv: Boolean($public.MAILWOMAN_DATA_ROOT) }),
		candidatePath: defaultCandidatePath,
		wofShardPaths: defaultWOFShardPaths,
		poiPath: () => dataRootPath("poi", "poi.db"),
		readPoiManifest,
		loadOnnx: async () => {
			await import("onnxruntime-node")
		},
		nodeVersion: process.versions.node,
		enginesFloor: readEnginesFloor(),
		overlayLocales: ["fr-fr"],
	}
}

// ---------------------------------------------------------------------------
// Fact gathering → checks
// ---------------------------------------------------------------------------

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
	const candidate = deps.candidatePath()

	if (candidate) {
		return { found: { kind: "candidate", path: candidate, sizeBytes: deps.fileSize(candidate) }, probed: [candidate] }
	}
	const shards = deps.wofShardPaths()
	const existing = shards.find((p) => deps.existsSync(p))

	if (existing) {
		return { found: { kind: "wof", path: existing, sizeBytes: deps.fileSize(existing) }, probed: shards }
	}

	return { probed: shards }
}

async function gatherPoi(deps: DoctorDeps): Promise<PoiObservation> {
	const path = deps.poiPath()

	if (!deps.existsSync(path)) return { path, exists: false }

	try {
		return { path, exists: true, manifest: await deps.readPoiManifest(path) }
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
 * Run every diagnostic and assemble the report. The check ORDER is the render order: core first (weights, runtime),
 * then the optional data layers, then the informational locale overlays. Pure verdict logic lives in
 * {@link ./checks.ts}; this only gathers the facts through the injected {@link DoctorDeps}.
 */
export async function runDoctor(overrides?: Partial<DoctorDeps>): Promise<DoctorReport> {
	const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides }

	// Core: weights + runtime.
	const weights = weightsCheck(gatherWeights(deps))
	const nodeCheck = nodeVersionCheck({ nodeVersion: deps.nodeVersion, enginesFloor: deps.enginesFloor })

	let onnxLoadable = false
	let onnxError: string | undefined

	try {
		await deps.loadOnnx()
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
	const poi = poiCheck(await gatherPoi(deps))

	// Informational: locale overlays.
	const overlays = deps.overlayLocales.map((locale) => gatherOverlay(deps, locale))

	return assembleReport([weights, nodeCheck, onnx, dataRoot, gazetteer, poi, ...overlays])
}
