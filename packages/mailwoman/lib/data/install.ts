/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Execute an installation plan: acquire, validate, install immutably, then activate atomically.
 *
 *   A downloaded artifact of a selection bundle is sealed, hashed and validated in the staging area, then moved
 *   whole into `db/<role>/<sha256 hex>/` with its manifest and receipt by one directory rename. A bundle's
 *   artifacts activate only when every one of them installed, so related artifacts are selected together.
 *   The installed ones of a bundle that failed stay installed and unselected, and the next pull verifies and
 *   activates them without transferring them again. All bundles of one request are selected by one
 *   replacement of `active.json`, refused when another writer moved the selection after the plan was made.
 *   Any failure before that rename leaves the previous selection as it was.
 *
 *   A conventional-path bundle is written where its readers resolve it today, sealed and swapped into place.
 */

import type { APIClient } from "@mailwoman/core/api"
import { acquireDirectoryLock } from "@mailwoman/core/fs/lock"
import { readFileHead } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, movePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import {
	type ActiveSelection,
	type ArtifactManifest,
	ArtifactFormat,
	artifactIDFromSHA256,
	artifactManifestProblems,
	artifactSetID,
	type InstalledArtifact,
	type LayerInstallation,
	layerInstallationID,
	NormalizationRequirement,
	type ReaderCompatibility,
	readerIncompatibility,
	ROLE_REQUIREMENTS,
	type SelectionEntry,
	type ServingRole,
	UnreadableArtifactError,
	UnreadableReason,
} from "@mailwoman/core/layers"
import type { layerschemadatabase } from "@mailwoman/core/layers/schema"
import { STREET_KEY_NORMALIZATION, STREET_LOCALES } from "@mailwoman/resolver-wof-sqlite/street/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed/db"
import { basename, relative, resolvePath } from "path-ts"

import {
	AcquisitionCancelledError,
	acquireRemoteObject,
	acquisitionDirectory,
	type AcquisitionReceipt,
	readRemoteIdentity,
	type RemoteIdentity,
} from "#data/acquire"
import {
	catalogPaths,
	readInstalledManifest,
	replaceActiveSelection,
	writeInstallation,
	writeRecordAtomically,
} from "#data/catalog"
import { probeManifest } from "#data/inventory"
import { licensedArtifactName, requestGrantedDownload } from "#data/licensed"
import {
	type InstallationPlan,
	type InstalledCopy,
	PlannedAction,
	type PlannedArtifact,
	type PlannedBundle,
	ProblemKind,
} from "#data/plan"
import { PUBLISHED_SCHEMA_VERSION, selectionScopeOf } from "#data/registry"

/**
 * What happened to one planned artifact.
 */
export const ArtifactOutcome = {
	Installed: "installed",
	Reused: "reused",
	Activated: "activated",
	Skipped: "skipped",
	Failed: "failed",
	Cancelled: "cancelled",
} as const

export type ArtifactOutcome = (typeof ArtifactOutcome)[keyof typeof ArtifactOutcome]

/**
 * One planned artifact's result.
 */
export interface ArtifactResult {
	bundle: string
	remotePath: string
	outcome: ArtifactOutcome
	detail: string
	/**
	 * The artifact's installed or conventional path, or `null` when it did not install.
	 */
	path: string | null
	/**
	 * What kind of failure a failed or cancelled artifact met, or `null` when it did not fail.
	 */
	problem: ProblemKind | null
}

/**
 * The kind of failure an error during installation is.
 */
function problemOf(error: unknown): ProblemKind {
	if (error instanceof AcquisitionCancelledError) return ProblemKind.Cancelled

	if (error instanceof UnreadableArtifactError) {
		return error.reason === UnreadableReason.Unsupported ? ProblemKind.Unsupported : ProblemKind.Corrupt
	}

	return ProblemKind.Transfer
}

/**
 * The result of executing a plan.
 */
export interface InstallationResult {
	ok: boolean
	results: ArtifactResult[]
	/**
	 * Lines explaining why a bundle was skipped whole, such as an unknown name, a refusal or a license.
	 */
	refusedBundles: Array<{ bundle: string; lines: string[] }>
	/**
	 * The generation this run wrote, or `null` when the selection did not change.
	 */
	selection: ActiveSelection | null
	/**
	 * Why activation failed, or `null`.
	 * The previous selection stays in force when it is set.
	 */
	activationError: string | null
	cancelled: boolean
}

/**
 * What the readers in this release open, per role.
 *
 * An artifact outside these is refused before it is installed rather than opened with a default.
 */
export function readerCompatibility(role: ServingRole): ReaderCompatibility {
	const keyed = ROLE_REQUIREMENTS[role].normalization === NormalizationRequirement.Required

	return {
		role,
		schemaVersions: [PUBLISHED_SCHEMA_VERSION],
		normalizations: keyed ? STREET_LOCALES.map((locale) => ({ ...STREET_KEY_NORMALIZATION, locale })) : [],
	}
}

const SQLITE_HEADER = "SQLite format 3\u0000"

/**
 * The manifest of a downloaded SQLite artifact, from its sealed bytes, its own `layer_manifest`
 * when it has one, and the registry's record for the fields the file does not record.
 *
 * @throws When the file is not SQLite or cannot be opened.
 */
async function manifestForDownload(
	path: string,
	planned: PlannedArtifact,
	publishers: readonly string[],
	expression: string,
	now: Date
): Promise<ArtifactManifest> {
	if ((await readFileHead(path, SQLITE_HEADER.length)) !== SQLITE_HEADER) {
		throw new Error(`${planned.artifact.remotePath} is not a SQLite database`)
	}

	const probed = probeManifest(path)

	if (probed.error) throw new Error(`${planned.artifact.remotePath} could not be opened: ${probed.error}`)

	let coverageEvidence = false

	{
		const db = new DatabaseClient<layerschemadatabase>(path, { readOnly: true })

		try {
			coverageEvidence = tableExists(db, "layer_coverage")
		} finally {
			db.destroy()
		}
	}

	const recorded = probed.manifest
	const hex = await sha256File(path)
	const stats = await tryStat(path)

	return {
		id: artifactIDFromSHA256(hex),
		role: planned.available.role,
		format: ArtifactFormat.SQLite,
		schemaVersion: planned.available.schemaVersion,
		bytes: stats?.size ?? 0,
		normalization: planned.available.normalization,
		scope: planned.available.scope,
		observedCountries: null,
		coverageEvidence,
		sources: recorded
			? [
					{
						publisher: recorded.source,
						release: recorded.source_vintage || null,
						url: recorded.source_url ?? null,
						sha256: recorded.source_sha256 ?? null,
						md5: null,
					},
				]
			: publishers.map((publisher) => ({ publisher, release: null, url: null, sha256: null, md5: null })),
		recipe: null,
		builderSHA: recorded?.build_sha || null,
		// The artifact's own expression is the authority for its contents.
		license: recorded?.license || expression,
		createdAt: now.toISOString(),
	}
}

/**
 * Whether an installed copy's bytes still hash to its identity.
 */
async function verifyCopy(copy: InstalledCopy): Promise<string | null> {
	const stats = await tryStat(copy.path)

	if (!stats) return `${copy.path} is missing`

	if (stats.size !== copy.manifest.bytes)
		return `${copy.path} holds ${stats.size} bytes; its manifest records ${copy.manifest.bytes}`

	const id = artifactIDFromSHA256(await sha256File(copy.path))

	return id === copy.manifest.id ? null : `${copy.path} hashes to ${id}; its manifest records ${copy.manifest.id}`
}

interface ExecuteOptions {
	client: APIClient
	signal?: AbortSignal
	onProgress?: (message: string) => void
	now?: () => Date
}

/**
 * Move a validated artifact, its manifest and its receipt into `db/<role>/<hex>/` with one directory rename.
 *
 * An identical artifact already installed there is kept, and the staged copy is discarded.
 *
 * @param receipt How the artifact was acquired: a transfer's {@link AcquisitionReceipt}, or a build's record.
 */
export async function placeArtifact(
	dataRoot: string,
	stagedPath: string,
	fileName: string,
	manifest: ArtifactManifest,
	receipt: AcquisitionReceipt | Readonly<Record<string, unknown>>
): Promise<string> {
	const paths = catalogPaths(dataRoot)
	const destination = paths.artifactDirectory(manifest.role, manifest.id)
	const finalPath = destination(fileName).toString()

	if (await readInstalledManifest(destination).catch(() => null)) {
		await removePathIfPresent(stagedPath)

		return finalPath
	}

	const staging = `${destination.toString()}.staging-${process.pid}`

	await removePathIfPresent(staging)
	await makeDirectories(staging)
	await movePath(stagedPath, resolvePath(staging, fileName))
	await writeRecordAtomically(manifest, resolvePath(staging, "manifest.json"))
	await writeRecordAtomically(receipt, resolvePath(staging, "receipt.json"))
	await movePath(staging, destination)

	return finalPath
}

async function acquire(
	plan: InstallationPlan,
	planned: PlannedArtifact,
	bundle: PlannedBundle,
	options: ExecuteOptions
) {
	const grantToken = bundle.access?.kind === "granted" ? bundle.access.token : null
	let identity: RemoteIdentity
	let downloadURL: string | undefined

	if (grantToken && bundle.bundle) {
		// A licensed artifact is absent from the public bucket.
		// Its source is the worker's presigned URL, and its one check is the size the worker's catalog records.
		const granted = await requestGrantedDownload(grantToken, licensedArtifactName(bundle.bundle, planned.artifact))

		identity = { url: planned.url, contentLength: granted.bytes, etag: null, lastModified: null, md5: null }
		downloadURL = granted.url
	} else {
		identity = await readRemoteIdentity(options.client, planned.url, planned.artifact.md5Sidecar)
	}

	return acquireRemoteObject({
		dataRoot: plan.dataRoot,
		remotePath: planned.artifact.remotePath,
		identity,
		...(downloadURL ? { downloadURL } : {}),
		// A plain GET against the public bucket answers Cloudflare's block page, while a ranged GET streams the object.
		headers: { range: "bytes=0-" },
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
		...(options.now ? { now: options.now } : {}),
	})
}

/**
 * Execute a plan.
 *
 * Refused, unknown and license-refused bundles are skipped before any transfer.
 * A cancelled transfer stops the run, keeps its partial bytes, and leaves the selection as it was.
 */
export async function executeInstallation(
	plan: InstallationPlan,
	options: ExecuteOptions
): Promise<InstallationResult> {
	const installLock = catalogPaths(plan.dataRoot).installLock

	// One installer runs per data root.
	// A second refuses before any transfer, so the first completes rather than both
	// failing on each other's staging directories.
	await using _installer = await acquireDirectoryLock(
		installLock,
		(held) =>
			`another installer is running under ${plan.dataRoot}` +
			(held ? ` (pid ${held.pid} on ${held.host} since ${held.started_at})` : "") +
			`; wait for it to finish and run the command again (lock ${installLock})`
	)

	const now = options.now ?? (() => new Date())
	const results: ArtifactResult[] = []
	const refusedBundles: InstallationResult["refusedBundles"] = []
	const entries: SelectionEntry[] = []
	// The results whose artifacts the selection replacement below activates.
	const selected: ArtifactResult[] = []
	let cancelled = false

	for (const bundle of plan.bundles) {
		const refusal = [
			...bundle.problems,
			...bundle.refusals.map(
				({ subject, finding }) => `refused --refuse ${finding.refusal}: ${finding.reason} (${subject})`
			),
			...(bundle.access?.kind === "refused" ? bundle.access.lines : []),
		]

		if (refusal.length || !bundle.bundle) {
			refusedBundles.push({ bundle: bundle.name, lines: refusal })

			continue
		}

		const activations: Array<{
			planned: PlannedArtifact
			installationID: InstalledCopy["installationID"] | null
			manifest: ArtifactManifest
			path: string
		}> = []

		let bundleFailed = false

		for (const planned of bundle.artifacts) {
			if (cancelled) break

			const record = (
				outcome: ArtifactOutcome,
				detail: string,
				path: string | null,
				problem: ProblemKind | null = null
			) =>
				results.push({ bundle: bundle.name, remotePath: planned.artifact.remotePath, outcome, detail, path, problem })

			try {
				switch (planned.action) {
					case PlannedAction.Present:
						record(ArtifactOutcome.Skipped, `already present (${planned.existingPath}); skipped`, planned.existingPath)

						break
					case PlannedAction.Reuse:
					case PlannedAction.Activate: {
						const copy = planned.installed!
						const problem = await verifyCopy(copy)

						if (problem) {
							throw new UnreadableArtifactError(
								copy.path,
								UnreadableReason.Corrupt,
								`the installed copy failed verification: ${problem}. Pull again with --force`
							)
						}

						if (planned.action === PlannedAction.Reuse) {
							record(ArtifactOutcome.Reused, `installed and verified at ${copy.path}; nothing transferred`, copy.path)
						} else {
							activations.push({
								planned,
								installationID: copy.installationID,
								manifest: copy.manifest,
								path: copy.path,
							})
						}

						break
					}
					case PlannedAction.Download: {
						const acquired = await acquire(plan, planned, bundle, options)

						for (const line of acquired.restartReason ? [acquired.restartReason] : []) {
							options.onProgress?.(line)
						}

						await sealDatabase(acquired.path)

						if (bundle.entry?.activation !== "selection") {
							await makeDirectories(resolvePath(planned.destination, ".."))
							await swapDatabaseIntoPlace(acquired.path, planned.destination)
							await removePathIfPresent(acquisitionDirectory(plan.dataRoot, planned.url))

							record(
								ArtifactOutcome.Installed,
								`${acquired.receipt.verifiedBy} verified → ${planned.destination}`,
								planned.destination
							)

							break
						}

						const manifest = await manifestForDownload(
							acquired.path,
							planned,
							bundle.bundle.rights.publishers,
							bundle.bundle.rights.expression,
							now()
						)

						const problems = artifactManifestProblems(manifest)
						const incompatible = readerIncompatibility(manifest, readerCompatibility(manifest.role))

						if (problems.length || incompatible) {
							await removePathIfPresent(acquired.path)
							throw new UnreadableArtifactError(
								planned.url,
								incompatible ? UnreadableReason.Unsupported : UnreadableReason.Unmanifested,
								`refused before installation: ${incompatible ?? problems.join("; ")}`
							)
						}

						const path = await placeArtifact(
							plan.dataRoot,
							acquired.path,
							basename(planned.artifact.localPath),
							manifest,
							acquired.receipt
						)

						await removePathIfPresent(acquisitionDirectory(plan.dataRoot, planned.url))
						activations.push({ planned, installationID: null, manifest, path })

						break
					}
				}
			} catch (error) {
				bundleFailed = true

				if (error instanceof AcquisitionCancelledError) {
					cancelled = true
					record(ArtifactOutcome.Cancelled, error.message, null, ProblemKind.Cancelled)
				} else {
					record(ArtifactOutcome.Failed, error instanceof Error ? error.message : String(error), null, problemOf(error))
				}
			}
		}

		if (!activations.length) continue

		const fresh = activations.filter((activation) => !activation.installationID)
		let freshID: LayerInstallation["id"] | null = null

		if (fresh.length) {
			const members = fresh.map(({ manifest }) => ({
				artifactID: manifest.id,
				role: manifest.role,
				schemaVersion: manifest.schemaVersion,
			}))

			const set = artifactSetID(members)

			const origin = {
				kind: "published" as const,
				entry: bundle.name,
				release: fresh
					.map(({ planned }) => planned.artifact.remotePath)
					.toSorted()
					.join(","),
			}

			const artifacts: InstalledArtifact[] = fresh.map(({ manifest, path }) => ({
				artifactID: manifest.id,
				role: manifest.role,
				path: relative(plan.dataRoot, path),
			}))

			freshID = layerInstallationID(set, origin)

			await writeInstallation(plan.dataRoot, {
				id: freshID,
				artifactSet: set,
				origin,
				artifacts,
				installedAt: now().toISOString(),
			})
		}

		if (bundleFailed || cancelled) {
			// Related artifacts are selected together.
			// The ones that installed are recorded and wait, unselected, for the next pull.
			// That pull verifies and selects them without transferring them again.
			for (const { planned, path } of activations) {
				results.push({
					bundle: bundle.name,
					remotePath: planned.artifact.remotePath,
					outcome: ArtifactOutcome.Failed,
					detail: `installed at ${path} and not selected, because another artifact of ${bundle.name} did not install`,
					path,
					problem: ProblemKind.SiblingFailed,
				})
			}

			continue
		}

		for (const activation of activations) {
			const installationID = activation.installationID ?? freshID!

			entries.push({
				role: activation.manifest.role,
				scope: selectionScopeOf(activation.planned.available),
				order: [{ installationID, artifactID: activation.manifest.id }],
			})
		}

		for (const { planned, path, installationID } of activations) {
			const result: ArtifactResult = {
				bundle: bundle.name,
				remotePath: planned.artifact.remotePath,
				outcome: installationID ? ArtifactOutcome.Activated : ArtifactOutcome.Installed,
				detail: installationID ? `verified and selected at ${path}` : `installed and selected at ${path}`,
				path,
				problem: null,
			}

			results.push(result)
			selected.push(result)
		}
	}

	let selection: ActiveSelection | null = null
	let activationError: string | null = null

	if (entries.length && !cancelled) {
		try {
			selection = await replaceActiveSelection(
				plan.dataRoot,
				{ basedOn: plan.basedOnGeneration, set: entries },
				{ now }
			)
		} catch (error) {
			activationError = `${error instanceof Error ? error.message : String(error)}. The previous selection stays in force, and the next pull selects the installed artifacts`

			for (const result of selected) {
				result.outcome = ArtifactOutcome.Failed
				result.detail = `installed at ${result.path} and not selected`
				result.problem = ProblemKind.Activation
			}
		}
	}

	const ok =
		!cancelled &&
		!activationError &&
		!refusedBundles.length &&
		results.every((result) => result.outcome !== ArtifactOutcome.Failed && result.outcome !== ArtifactOutcome.Cancelled)

	return { ok, results, refusedBundles, selection, activationError, cancelled }
}
