/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The IO half of `mailwoman doctor`: gather the environment facts (weights resolution, data-root
 *   writability, gazetteer discovery, POI manifest, Node + ONNX runtime) and hand them to the pure
 *   verdict logic in {@link ./checks.ts}. All the environment-dependent dependencies (`fs`, env, dynamic
 *   imports, DB reads) live behind {@link DoctorDeps} so the whole flow is injectable — a test drives
 *   `runDoctor` with fakes, and the default deps wire the real thing. Mirrors, never re-implements:
 *   weights resolution comes from `@mailwoman/neural/weights`, the data root from
 *   `@mailwoman/core/utils`, gazetteer discovery from the same candidate-first order `mailwoman
 *   geocode` uses, and the POI path from `gazetteer build poi`'s own default.
 */

import { mailwomanDataRoot } from "@mailwoman/core/data-root"
import { $public, DefaultMailwomanPaths } from "@mailwoman/core/env"
import { isWritable, pathExists, statPath } from "@mailwoman/core/fs/readers"
import { readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { isSelfServicePayload, type LicenseKeyVerification, verifyConfiguredLicenseKey } from "@mailwoman/core/license"
import { confirmLicenseKeyPublished, type LicenseKeyPublication } from "@mailwoman/core/license/publication"
import { checkLicenseStatus, type LicenseStatusAnswer } from "@mailwoman/core/license/status"
import { resolveWeights, weightsPackageName } from "@mailwoman/neural/weights"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { readMailwomanManifest } from "#cli-kit/metadata"
import {
	assembleReport,
	checkPOI,
	dataRootCheck,
	gazetteerCheck,
	layerLicenseCheck,
	localeOverlayCheck,
	nodeVersionCheck,
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
import {
	layerDatabaseAlternates,
	layerDatabasePath,
	layerDatabases,
	type LayerDatabaseRef,
	type LayerID,
} from "#geocode/layer-paths"
import { conventionCandidateDBPath, resolveCandidateDBPath, resolveWOFDatabasePaths } from "#resolver-backend"

/**
 * The resolved-weights shape the runner needs — a structural subset of `@mailwoman/neural`'s `ResolvedWeights`.
 */
interface ResolvedWeightsLike {
	source: string
	modelPath: string
	tokenizerPath: string
}

/**
 * Every environment dependency `runDoctor` touches. Injected in tests; {@link defaultDoctorDeps} wires the real ones.
 */
export interface DoctorDeps {
	/**
	 * File-existence probe.
	 */
	exists(path: string): Promise<boolean>
	/**
	 * Byte size of a file, or `undefined` when it can't be stat'd.
	 */
	fileSize(path: string): Promise<number | undefined>
	/**
	 * Whether a path is writable (W_OK).
	 */
	isWritable(path: string): Promise<boolean>
	/**
	 * Resolve a locale's weights package (throws when unresolvable) — mirrors `@mailwoman/neural`.
	 */
	resolveWeights(locale: string): Promise<ResolvedWeightsLike>
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
	envCandidatePath(): Promise<string | undefined>
	/**
	 * The `<data-root>/wof/candidate.db` convention path IF it exists on disk — used to detect the env-unset trap.
	 */
	conventionCandidatePath(): Promise<string | undefined>
	/**
	 * The WOF admin database paths to probe ($MAILWOMAN_WOF_DB split, else the default database set).
	 */
	wofExtractPaths(): string[]
	/**
	 * The default POI layer path (`gazetteer build poi`'s own default).
	 */
	poiPath(): string
	/**
	 * Read + validate a POI layer manifest (throws on a missing/invalid manifest).
	 */
	/**
	 * Read the identity fields of a layer manifest (throws on a missing/invalid manifest). Serves the POI presence check
	 * and every layer's license line.
	 */
	readLayerIdentity(path: string): Promise<LayerIdentity>
	/**
	 * Every layer database the geocode session would attach, present or not; the doctor reports the license of each one
	 * that is on disk.
	 */
	layerDatabases(): LayerDatabaseRef[]
	/**
	 * `.db` files in a layer's directory other than the one the session attaches — a build under another name.
	 */
	layerAlternates(id: LayerID): Promise<string[]>
	/**
	 * Mailwoman's own `license` expression, from its package manifest.
	 */
	runtimeLicense(): Promise<string>
	/**
	 * The configured license key, verified offline against the trusted keys this build ships; `undefined` when none is
	 * configured.
	 */
	licenseKey(): Promise<LicenseKeyVerification | undefined>
	/**
	 * Ask mailwoman.ai's well-known register whether a key id is still listed. Called only when a key is configured;
	 * answers `unreachable` rather than throwing when there is no route.
	 */
	confirmLicenseKeyPublished(kid: string): Promise<LicenseKeyPublication>
	/**
	 * Ask the license worker whether a self-service license still stands. Called only when the configured key names one;
	 * answers `unreachable` rather than throwing when there is no route.
	 */
	checkLicenseStatus(lid: string): Promise<LicenseStatusAnswer>
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
async function readEnginesFloor(): Promise<string> {
	try {
		return (await readMailwomanManifest()).engines?.node ?? ">=0"
	} catch {
		return ">=0"
	}
}

/**
 * The `<data-root>/wof/candidate.db` convention path if it exists on disk — the file a fresh consumer downloads.
 */
async function defaultConventionCandidatePath(dataRoot: string): Promise<string | undefined> {
	if ($public.MAILWOMAN_CANDIDATE_DB === "none") return undefined

	const convention = conventionCandidateDBPath(dataRoot)

	return (await pathExists(convention)) ? convention : undefined
}

/**
 * Open a POI db READ-ONLY, read its layer manifest, and narrow it to the identity fields doctor prints.
 */
/**
 * Open a layer db READ-ONLY and read the identity fields of its manifest — what the layer is and what it asks.
 */
async function readLayerIdentity(path: string): Promise<LayerIdentity> {
	using kdb = new DatabaseClient<LayerContractDatabase>(path, { readOnly: true })
	const manifest = await readLayerManifest(kdb)

	return {
		name: manifest.name,
		version: manifest.version,
		sourceVintage: manifest.sourceVintage,
		license: manifest.license,
		attribution: manifest.attribution ?? null,
	}
}

/**
 * Mailwoman's own license expression, read from the package manifest located by self-reference (the same lookup
 * `readEnginesFloor` uses), so the doctor reports the license that ships rather than a string in this file.
 */
async function readRuntimeLicense(): Promise<string> {
	return (await readMailwomanManifest()).license
}

/**
 * The production dependencies — the real filesystem, env, weights resolver, and dynamic imports.
 */
export async function defaultDoctorDeps(): Promise<DoctorDeps> {
	const dataRoot = mailwomanDataRoot()

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
		dataRoot: () => ({ path: dataRoot, fromEnv: dataRoot !== DefaultMailwomanPaths.data }),
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
		loadONNX: async () => {
			await import("onnxruntime-node")
		},
		nodeVersion: process.versions.node,
		enginesFloor: await readEnginesFloor(),
		overlayLocales: ["fr-fr"],
	}
}

// MARK: Fact gathering → checks

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
	// Same precedence the tools apply: explicit/env candidate.db → convention-path candidate.db → WOF FTS databases.
	// The convention probe must come BEFORE the databases, or a machine holding both reports the FTS database while every
	// tool on it uses the candidate table — doctor's one job is to name the backend actually in use.
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

	// Existence is materialized before the first-hit search so the search loop can await directly.
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
 * The license observation for one layer database, or `undefined` when the database is absent — an absent layer is not
 * in play and gets no license line, which keeps "not installed" distinct from "installed under an unknown license".
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
	const deps: DoctorDeps = { ...(await defaultDoctorDeps()), ...overrides }

	// Core: weights + runtime.
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

	// Optional data layers.
	const root = deps.dataRoot()

	const dataRoot = dataRootCheck({
		path: root.path,
		exists: await deps.exists(root.path),
		writable: await deps.isWritable(root.path),
		fromEnv: root.fromEnv,
	})

	const gazetteer = gazetteerCheck(await gatherGazetteer(deps))
	const poi = checkPOI(await gatherPOI(deps))

	// License posture: mailwoman's own branch, then each attached layer's recorded license. Informational.
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

	const layerLicenses = (await Promise.all(deps.layerDatabases().map((layer) => gatherLayerLicense(deps, layer))))
		.filter((o): o is LayerLicenseObservation => o !== undefined)
		.map(layerLicenseCheck)

	// Informational: locale overlays.
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
		...overlays,
	])
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

//#endregion
