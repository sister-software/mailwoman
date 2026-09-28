/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The IO half of `mailwoman doctor`, with every environment dependency behind {@link DoctorDeps}
 *   so a test drives `runDoctor` with fakes and the default deps wire the real ones.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { DefaultMailwomanPaths } from "@mailwoman/core/env"
import { isWritable, pathExists, statPath } from "@mailwoman/core/fs/readers"
import { readLayerManifest, type layerschemadatabase } from "@mailwoman/core/layers"
import { isSelfServicePayload, type LicenseKeyVerification, verifyConfiguredLicenseKey } from "@mailwoman/core/license"
import { confirmLicenseKeyPublished, type LicenseKeyPublication } from "@mailwoman/core/license/publication"
import { checkLicenseStatus, type LicenseStatusAnswer } from "@mailwoman/core/license/status"
import { resolveWeights, weightsPackageName } from "@mailwoman/neural/weights"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { readMailwomanManifest } from "#cli/kit/metadata"
import { type ObligationRefusal, parseObligationRefusals } from "#data/obligations"
import {
	assembleReport,
	checkPOI,
	CheckStatus,
	dataRootCheck,
	gazetteerCheck,
	layerLicenseCheck,
	localeOverlayCheck,
	nodeVersionCheck,
	obligationPostureCheck,
	onnxRuntimeCheck,
	runtimeLicenseCheck,
	weightsCheck,
	type DoctorCheck,
	type DoctorReport,
	type GazetteerObservation,
	type LayerIdentity,
	type LayerLicenseObservation,
	type POIObservation,
	type WeightsObservation,
} from "#doctor/checks"
import { $public } from "#env"
import {
	layerDatabaseAlternates,
	layerDatabasePath,
	layerDatabases,
	type LayerDatabaseRef,
	type LayerID,
} from "#geocode/layer-paths"
import { conventionCandidateDBPath, resolveCandidateDBPath, resolveWOFDatabasePaths } from "#resolver-backend"

/**
 * The resolved-weights shape the runner needs: a structural subset of
 * `@mailwoman/neural`'s `ResolvedWeights`.
 */
interface ResolvedWeightsLike {
	source: string
	modelPath: string
	tokenizerPath: string
}

/**
 * Every environment dependency {@link runDoctor} touches, injected in tests
 * and wired to the real ones by {@link defaultDoctorDeps}.
 */
export interface DoctorDeps {
	exists(path: string): Promise<boolean>
	fileSize(path: string): Promise<number | undefined>
	isWritable(path: string): Promise<boolean>
	/**
	 * Resolves a locale's weights package, throwing when unresolvable.
	 */
	resolveWeights(locale: string): Promise<ResolvedWeightsLike>
	weightsPackageName(locale: string): string
	dataRoot(): { path: string; fromEnv: boolean }
	/**
	 * The candidate.db the tools would actually use, with no convention-path fallback —
	 * the same precedence geocode and serve apply.
	 */
	envCandidatePath(): Promise<string | undefined>
	/**
	 * The `<data-root>/db/wof/candidate.db` convention path if it exists on disk,
	 * used to detect the env-unset trap.
	 */
	conventionCandidatePath(): Promise<string | undefined>
	wofExtractPaths(): string[]
	/**
	 * The default POI layer path, matching `gazetteer build poi`'s own default.
	 */
	poiPath(): string
	/**
	 * Reads the identity fields of a layer manifest, throwing on a missing or invalid manifest.
	 */
	readLayerIdentity(path: string): Promise<LayerIdentity>
	/**
	 * Every layer database the geocode session would attach, present or not.
	 */
	layerDatabases(): LayerDatabaseRef[]
	/**
	 * `.db` files in a layer's directory other than the one the session attaches, a build under another name.
	 */
	layerAlternates(id: LayerID): Promise<string[]>
	runtimeLicense(): Promise<string>
	/**
	 * The configured license key, verified offline against the trusted keys this
	 * build ships, or `undefined` when none is configured.
	 */
	licenseKey(): Promise<LicenseKeyVerification | undefined>
	/**
	 * Asks mailwoman.ai's well-known register whether a key id is still listed,
	 * answering `unreachable` rather than throwing when there is no route.
	 */
	confirmLicenseKeyPublished(kid: string): Promise<LicenseKeyPublication>
	/**
	 * Asks the license worker whether a self-service license still stands, answering
	 * `unreachable` rather than throwing when there is no route.
	 */
	checkLicenseStatus(lid: string): Promise<LicenseStatusAnswer>
	/**
	 * The obligation classes the installation refuses, left raw so a class
	 * `MAILWOMAN_REFUSE_OBLIGATIONS` misspells is reported by the check rather than thrown here.
	 */
	refusedObligations(): string[]
	/**
	 * Attempt to load the ONNX native binding (throws when unavailable).
	 */
	loadONNX(): Promise<void>
	nodeVersion: string
	enginesFloor: string
	overlayLocales: string[]
}

/**
 * Reads `engines.node` from mailwoman's own package.json, degrading to `">=0"`
 * when the manifest cannot be resolved rather than throwing at module load.
 */
async function readEnginesFloor(): Promise<string> {
	try {
		return (await readMailwomanManifest()).engines?.node ?? ">=0"
	} catch {
		return ">=0"
	}
}

async function defaultConventionCandidatePath(dataRoot: PathBuilderLike): Promise<string | undefined> {
	if ($public.MAILWOMAN_CANDIDATE_DB === "none") return undefined

	const convention = conventionCandidateDBPath(dataRoot)

	return (await pathExists(convention)) ? convention : undefined
}

async function readLayerIdentity(path: string): Promise<LayerIdentity> {
	using kdb = new DatabaseClient<layerschemadatabase>(path, { readOnly: true })
	const manifest = await readLayerManifest(kdb)

	return {
		name: manifest.name,
		version: manifest.version,
		sourceVintage: manifest.sourceVintage,
		license: manifest.license,
		attribution: manifest.attribution ?? null,
	}
}

async function readRuntimeLicense(): Promise<string> {
	return (await readMailwomanManifest()).license
}

/**
 * The production dependencies include the real filesystem, env, weights resolver and dynamic imports.
 */
export async function defaultDoctorDeps(): Promise<DoctorDeps> {
	const dataRoot = dataRootPath()

	return {
		exists: pathExists,
		fileSize: async (path) => {
			try {
				return (await statPath(path)).size
			} catch {
				return undefined
			}
		},
		isWritable,
		resolveWeights: (locale) => resolveWeights({ locale }),
		weightsPackageName,
		dataRoot: () => ({ path: dataRoot.toString(), fromEnv: dataRoot.toString() !== DefaultMailwomanPaths.data }),
		envCandidatePath: async () =>
			$public.MAILWOMAN_CANDIDATE_DB ? await resolveCandidateDBPath(undefined, dataRoot) : undefined,
		conventionCandidatePath: () => defaultConventionCandidatePath(dataRoot),
		wofExtractPaths: () => resolveWOFDatabasePaths(undefined, dataRoot),
		poiPath: () => layerDatabasePath(dataRoot, "poi"),
		readLayerIdentity,
		layerDatabases: () => layerDatabases(dataRoot),
		layerAlternates: (id) => layerDatabaseAlternates(dataRoot, id),
		runtimeLicense: readRuntimeLicense,
		licenseKey: () => verifyConfiguredLicenseKey(),
		confirmLicenseKeyPublished: (kid) => confirmLicenseKeyPublished(kid),
		checkLicenseStatus: (lid) => checkLicenseStatus(lid),
		refusedObligations: () => ($public.MAILWOMAN_REFUSE_OBLIGATIONS ?? "").split(",").filter((value) => value.trim()),
		loadONNX: async () => {
			await import("onnxruntime-node")
		},
		nodeVersion: process.versions.node,
		enginesFloor: await readEnginesFloor(),
		overlayLocales: ["fr-fr"],
	}
}

async function gatherWeights(deps: DoctorDeps): Promise<WeightsObservation> {
	try {
		const resolved = await deps.resolveWeights("en-us")

		return {
			resolved,
			modelSize: await deps.fileSize(resolved.modelPath),
			tokenizerSize: await deps.fileSize(resolved.tokenizerPath),
		}
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

async function gatherGazetteer(deps: DoctorDeps): Promise<GazetteerObservation> {
	// Precedence must match the tools: explicit/env candidate.db, then the convention-path
	// candidate.db, then the WOF FTS databases.
	const envCandidate = await deps.envCandidatePath()

	if (envCandidate) {
		return {
			envCandidate: { path: envCandidate, sizeBytes: await deps.fileSize(envCandidate) },
			probed: [envCandidate],
		}
	}

	const convention = await deps.conventionCandidatePath()
	const databases = deps.wofExtractPaths()

	if (convention) {
		return { conventionCandidate: convention, probed: [convention, ...databases] }
	}

	let existing: string | undefined

	for (const p of databases) {
		if (await deps.exists(p)) {
			existing = p

			break
		}
	}

	if (existing) {
		return { wofDatabase: { path: existing, sizeBytes: await deps.fileSize(existing) }, probed: databases }
	}

	return { probed: databases }
}

async function gatherPOI(deps: DoctorDeps): Promise<POIObservation> {
	const path = deps.poiPath()

	if (!(await deps.exists(path))) return { path, exists: false }

	try {
		return { path, exists: true, manifest: await deps.readLayerIdentity(path) }
	} catch (error) {
		return { path, exists: true, error: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * The license observation for one layer database, or `undefined` when it is absent,
 * keeping "not installed" distinct from "installed under an unknown license".
 */
async function gatherLayerLicense(
	deps: DoctorDeps,
	layer: LayerDatabaseRef
): Promise<LayerLicenseObservation | undefined> {
	if (!(await deps.exists(layer.path))) {
		const alternates = await deps.layerAlternates(layer.id)

		return alternates.length ? { ...layer, alternates } : undefined
	}

	try {
		return { ...layer, manifest: await deps.readLayerIdentity(layer.path) }
	} catch (error) {
		return { ...layer, error: error instanceof Error ? error.message : String(error) }
	}
}

async function gatherOverlay(deps: DoctorDeps, locale: string): Promise<DoctorCheck> {
	const packageName = deps.weightsPackageName(locale)

	try {
		const resolved = await deps.resolveWeights(locale)

		return localeOverlayCheck({ locale, packageName, resolved: true, source: resolved.source })
	} catch {
		return localeOverlayCheck({ locale, packageName, resolved: false })
	}
}

/**
 * Runs every diagnostic and assembles the report in runtime-first render order: node version,
 * the ONNX binding, the model weights, the optional data layers and the informational locale overlays.
 */
export async function runDoctor(overrides?: Partial<DoctorDeps>): Promise<DoctorReport> {
	const deps: DoctorDeps = { ...(await defaultDoctorDeps()), ...overrides }

	const weights = weightsCheck(await gatherWeights(deps))
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

	const root = deps.dataRoot()

	const dataRoot = dataRootCheck({
		path: root.path,
		exists: await deps.exists(root.path),
		writable: await deps.isWritable(root.path),
		fromEnv: root.fromEnv,
	})

	const gazetteerObservation = await gatherGazetteer(deps)
	const gazetteer = gazetteerCheck(gazetteerObservation)
	const poi = checkPOI(await gatherPOI(deps))

	const key = await deps.licenseKey()
	const publication = key && "kid" in key ? await deps.confirmLicenseKeyPublished(key.kid) : undefined

	const lidStatus =
		key && "payload" in key && isSelfServicePayload(key.payload)
			? await deps.checkLicenseStatus(key.payload.lid)
			: undefined

	const runtimeLicense = runtimeLicenseCheck({
		expression: await deps.runtimeLicense(),
		...(key ? { key } : {}),
		...(publication ? { publication } : {}),
		...(lidStatus ? { lidStatus } : {}),
	})

	const layerObservations = (
		await Promise.all(deps.layerDatabases().map((layer) => gatherLayerLicense(deps, layer)))
	).filter((o): o is LayerLicenseObservation => o !== undefined)

	const layerLicenses = layerObservations.map(layerLicenseCheck)

	const posture = await gatherObligationPosture(deps, gazetteerObservation, layerObservations)

	const overlays = await Promise.all(deps.overlayLocales.map((locale) => gatherOverlay(deps, locale)))

	return assembleReport([
		nodeCheck,
		onnx,
		weights,
		dataRoot,
		gazetteer,
		poi,
		runtimeLicense,
		...layerLicenses,
		...(posture ? [posture] : []),
		...overlays,
	])
}

/**
 * The obligation-posture check, or `undefined` when the installation refuses no class.
 */
async function gatherObligationPosture(
	deps: DoctorDeps,
	gazetteer: GazetteerObservation,
	layers: readonly LayerLicenseObservation[]
): Promise<DoctorCheck | undefined> {
	const raw = deps.refusedObligations()

	if (!raw.length) return undefined

	let refuse: ObligationRefusal[]

	try {
		refuse = parseObligationRefusals(raw)
	} catch (error) {
		return {
			id: "obligation-posture",
			label: "Obligation posture",
			core: false,
			status: CheckStatus.Degraded,
			detail: `MAILWOMAN_REFUSE_OBLIGATIONS could not be read: ${error instanceof Error ? error.message : String(error)}`,
			fix: "set MAILWOMAN_REFUSE_OBLIGATIONS to a comma-separated list of share-alike, unresolved",
		}
	}

	const recorded: Array<{ subject: string; expression: string }> = []
	const unreadable: string[] = []

	const gazetteerPath = gazetteer.envCandidate?.path ?? gazetteer.conventionCandidate ?? gazetteer.wofDatabase?.path

	if (gazetteerPath) {
		try {
			const identity = await deps.readLayerIdentity(gazetteerPath)

			recorded.push({ subject: identity.name, expression: identity.license })
		} catch {
			unreadable.push(gazetteerPath)
		}
	}

	for (const layer of layers) {
		if (layer.manifest) {
			recorded.push({ subject: layer.id, expression: layer.manifest.license })
		} else if (!layer.alternates?.length) {
			unreadable.push(layer.path)
		}
	}

	return obligationPostureCheck({ refuse, layers: recorded, unreadable })
}

// #region --verbose environment dump

/**
 * One resolved setting in the `--verbose` dump.
 */
export interface EnvironmentEntry {
	key: string
	/**
	 * The resolved value, with `undefined` rendered as `(unset)` rather than omitted
	 * so an unset variable is distinguishable from an absent row.
	 */
	value: string | undefined
	source?: string
}

/**
 * Every path and variable the checks above resolved, read through the same {@link DoctorDeps}
 * so the dump can never disagree with the verdicts.
 */
export async function describeEnvironment(overrides?: Partial<DoctorDeps>): Promise<EnvironmentEntry[]> {
	const deps: DoctorDeps = { ...(await defaultDoctorDeps()), ...overrides }
	const root = deps.dataRoot()

	const entries: EnvironmentEntry[] = [
		{ key: "node", value: `v${deps.nodeVersion}`, source: `engines ${deps.enginesFloor}` },
		{ key: "platform", value: `${process.platform}-${process.arch}` },
		{ key: "MAILWOMAN_DATA_ROOT", value: $public.MAILWOMAN_DATA_ROOT, source: root.fromEnv ? "env" : "unset" },
		{ key: "data root (resolved)", value: root.path, source: root.fromEnv ? "env" : "default" },
		{ key: "MAILWOMAN_CANDIDATE_DB", value: $public.MAILWOMAN_CANDIDATE_DB, source: "env" },
		{ key: "candidate.db (convention)", value: await deps.conventionCandidatePath(), source: "derived" },
		{ key: "MAILWOMAN_WOF_DB", value: $public.MAILWOMAN_WOF_DB, source: "env" },
		{ key: "POI layer", value: deps.poiPath(), source: "derived" },
		{ key: "MAILWOMAN_REFUSE_OBLIGATIONS", value: $public.MAILWOMAN_REFUSE_OBLIGATIONS, source: "env" },
	]

	for (const [index, database] of deps.wofExtractPaths().entries()) {
		entries.push({
			key: `WOF database [${index}]`,
			value: database,
			source: (await deps.exists(database)) ? "on disk" : "absent",
		})
	}

	try {
		const resolved = await deps.resolveWeights("en-us")

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

// #endregion
