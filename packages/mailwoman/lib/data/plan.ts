/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The installation planner `setup`, `data pull --dry-run` and `data pull` share.
 *
 *   A plan resolves a request for published bundles into the artifacts it would transfer, reuse or skip,
 *   with each one's size and how that size is known, its destination, the access it needs, the obligation
 *   refusals that apply, the dependencies not yet installed, the disk it needs against the disk available,
 *   and the selected sources its activation would replace. The planner reads the data root and the registry only.
 *   It writes no file and makes no network request.
 *
 *   An artifact already installed and selected is reused after verification. An artifact installed and not
 *   selected, such as one whose sibling failed on an earlier attempt, is verified and activated. A file at the
 *   conventional path a reader resolves today is left as it is, as `data pull` always has, unless `--force`.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { type FilesystemSpace, readFilesystemSpace } from "@mailwoman/core/fs/readers/stat"
import type { ArtifactID, ArtifactManifest, LayerInstallationID, SelectedSource } from "@mailwoman/core/layers"
import { selectedSources } from "@mailwoman/core/layers"
import { type PathBuilderLike, resolvePath } from "path-ts"

import type { AcquisitionReceipt } from "#data/acquire"
import {
	artifactURL,
	bundleArtifactPath,
	BUNDLES,
	type ArtifactTermsObservation,
	type BundleArtifact,
	type DataBundle,
	describeArtifactTerms,
	describeBundleRights,
	filterArtifacts,
	resolveBundleArtifacts,
} from "#data/bundles"
import { catalogPaths, LayerCatalog, readInstallations, readInstalledManifest } from "#data/catalog"
import { probeManifest } from "#data/inventory"
import { type ConfiguredKey, type LicensedPullDecision, licensedPullDecision } from "#data/licensed"
import { type ObligationFinding, obligationFindings, type ObligationRefusal } from "#data/obligations"
import {
	type AvailableArtifact,
	type AvailableDataEntry,
	availableDataEntry,
	selectionScopeOf,
	SizeBasis,
} from "#data/registry"
import { existingLocalPath, readReleaseManifest, type DataReleaseManifest } from "#data/release"

/**
 * What a plan does with one artifact.
 */
export const PlannedAction = {
	/**
	 * Transfer, validate and install it.
	 */
	Download: "download",
	/**
	 * It is installed and selected.
	 * Verify it and leave the selection as it is.
	 */
	Reuse: "reuse",
	/**
	 * It is installed and not selected.
	 * Verify it and select it.
	 */
	Activate: "activate",
	/**
	 * A file is at the conventional path today's readers resolve.
	 * Leave it.
	 */
	Present: "present",
} as const

export type PlannedAction = (typeof PlannedAction)[keyof typeof PlannedAction]

/**
 * Why a requested installation did not complete, kept distinct in human and structured output.
 */
export const ProblemKind = {
	/**
	 * The registry publishes no artifact for the request: an unknown bundle,
	 * or an `--only` that matched none.
	 */
	Unavailable: "unavailable",
	/**
	 * A licensed bundle and no token whose scope admits it.
	 */
	InsufficientAccess: "insufficient-access",
	/**
	 * A configured obligation refusal applies to the bundle's recorded expression or to a copy on disk.
	 */
	RefusedObligation: "refused-obligation",
	/**
	 * A bundle the request needs first is not installed.
	 * The request still installs.
	 */
	MissingDependency: "missing-dependency",
	/**
	 * The artifact's schema or normalization is one this release's reader does not open.
	 */
	Unsupported: "unsupported",
	/**
	 * The bytes fail verification: a digest, length or manifest mismatch.
	 */
	Corrupt: "corrupt",
	/**
	 * The transfer failed.
	 * Its partial bytes are kept for a resume.
	 */
	Transfer: "transfer",
	Cancelled: "cancelled",
	/**
	 * The artifact installed and stays unselected because another artifact of its bundle did not.
	 */
	SiblingFailed: "sibling-failed",
	/**
	 * Every artifact installed and the selection replacement was refused, such as by a concurrent installer.
	 */
	Activation: "activation",
	/**
	 * The recorded transfer does not fit in the free space of the data root's filesystem.
	 */
	InsufficientDisk: "insufficient-disk",
} as const

export type ProblemKind = (typeof ProblemKind)[keyof typeof ProblemKind]

/**
 * One problem a plan reports before any transfer.
 */
export interface PlanProblem {
	/**
	 * The bundle it concerns, or `null` for the plan as a whole.
	 */
	bundle: string | null
	kind: ProblemKind
	detail: string
}

/**
 * Every problem a plan states before any transfer, by kind.
 *
 * A missing dependency is listed and does not stop the installation.
 */
export function planProblems(plan: InstallationPlan): PlanProblem[] {
	const problems: PlanProblem[] = []

	for (const bundle of plan.bundles) {
		for (const detail of bundle.problems) {
			problems.push({ bundle: bundle.name, kind: ProblemKind.Unavailable, detail })
		}

		if (bundle.access?.kind === "refused") {
			problems.push({
				bundle: bundle.name,
				kind: ProblemKind.InsufficientAccess,
				detail: bundle.access.lines.join(" "),
			})
		}

		for (const { subject, finding } of bundle.refusals) {
			problems.push({
				bundle: bundle.name,
				kind: ProblemKind.RefusedObligation,
				detail: `--refuse ${finding.refusal}: ${finding.reason} (${subject})`,
			})
		}

		for (const dependency of bundle.missingDependencies) {
			problems.push({
				bundle: bundle.name,
				kind: ProblemKind.MissingDependency,
				detail: `${bundle.name} needs ${dependency}, which is not installed: mailwoman data pull ${dependency}`,
			})
		}
	}

	if (plan.fitsOnDisk === false && plan.disk) {
		problems.push({
			bundle: null,
			kind: ProblemKind.InsufficientDisk,
			detail: `${plan.transfer.recordedBytes} bytes to transfer and ${plan.disk.availableBytes} available at ${plan.disk.measuredAt}`,
		})
	}

	return problems
}

/**
 * An installed artifact found under the data root, with the receipt that ties it to a registry object.
 */
export interface InstalledCopy {
	installationID: LayerInstallationID
	artifactID: ArtifactID
	/**
	 * The absolute path of the artifact's file.
	 */
	path: string
	manifest: ArtifactManifest
	receipt: AcquisitionReceipt | null
}

/**
 * One artifact in a plan.
 */
export interface PlannedArtifact {
	bundle: string
	artifact: BundleArtifact
	available: AvailableArtifact
	url: string
	action: PlannedAction
	/**
	 * The installed copy a reuse or an activation reads, or `null`.
	 */
	installed: InstalledCopy | null
	/**
	 * The file at the conventional path, for a `present` artifact, or `null`.
	 */
	existingPath: string | null
	/**
	 * Where a download lands: `db/<role>/` under the data root for a selection bundle,
	 * or the conventional file path otherwise.
	 *
	 * A selection bundle's final directory is the artifact's digest, known once it is hashed.
	 */
	destination: string
	/**
	 * The selected sources for the artifact's role and scope that activating it would replace.
	 *
	 * Empty when the role and scope have no selected source, or when the artifact is the one already selected.
	 */
	replaces: readonly SelectedSource[]
}

/**
 * An obligation refusal that applies to a bundle, with what it applies to.
 */
export interface PlannedRefusal {
	subject: string
	finding: ObligationFinding
}

/**
 * One requested bundle in a plan.
 */
export interface PlannedBundle {
	name: string
	bundle: DataBundle | null
	entry: AvailableDataEntry | null
	/**
	 * Why the bundle cannot be planned, such as an unknown name or an `--only` that matched no artifact.
	 */
	problems: string[]
	/**
	 * The registry's rights lines, printed before any transfer.
	 */
	terms: string[]
	/**
	 * What the copies already on disk record, beside the registry.
	 */
	artifactTerms: string[]
	refusals: PlannedRefusal[]
	/**
	 * The access decision for a licensed bundle, or `null` for a free one.
	 */
	access: LicensedPullDecision | null
	/**
	 * Bundles this one needs that are neither installed nor in this plan.
	 */
	missingDependencies: string[]
	artifacts: PlannedArtifact[]
}

/**
 * The bytes a plan transfers, separating recorded sizes from unknown ones.
 */
export interface PlannedTransfer {
	/**
	 * The sum of the sizes the registry records for the artifacts to download.
	 */
	recordedBytes: number
	/**
	 * How those sizes are known.
	 * A plan made without network access has only estimates.
	 */
	basis: typeof SizeBasis.Estimated | typeof SizeBasis.Verified
	/**
	 * Artifacts to download whose size is not recorded.
	 */
	unknownCount: number
}

/**
 * A concrete installation plan.
 */
export interface InstallationPlan {
	dataRoot: string
	/**
	 * The selection generation the plan read, or `null` when the data root has none.
	 *
	 * Execution refuses to activate when the selection has moved past it.
	 */
	basedOnGeneration: number | null
	bundles: PlannedBundle[]
	transfer: PlannedTransfer
	/**
	 * The filesystem the data root is on, or `null` with {@link diskError} when it could not be read.
	 */
	disk: FilesystemSpace | null
	diskError: string | null
	/**
	 * Whether the recorded transfer fits in the available space, or `null` when either is unknown.
	 */
	fitsOnDisk: boolean | null
}

/**
 * What to plan.
 */
export interface InstallationRequest {
	bundles: readonly string[]
	only?: string | null
	force?: boolean
	dataRoot: PathBuilderLike
	host?: string
	refuse?: readonly ObligationRefusal[]
	/**
	 * Read only when a requested bundle is licensed.
	 */
	configuredKey?: () => Promise<ConfiguredKey | null>
	registry?: Readonly<Record<string, DataBundle>>
}

/**
 * Every installed artifact under the data root, selected or not, with its manifest and receipt.
 *
 * @throws {@link UnreadableArtifactError} when an installation record or manifest cannot be read.
 */
export async function readInstalledCopies(dataRoot: PathBuilderLike): Promise<InstalledCopy[]> {
	const root = resolvePath(dataRoot.toString())
	const copies: InstalledCopy[] = []

	for (const installation of await readInstallations(root)) {
		for (const artifact of installation.artifacts) {
			const path = resolvePath(root, artifact.path)
			const directory = resolvePath(path, "..")
			const manifest = await readInstalledManifest(directory)

			if (!manifest) continue

			const receipt = await tryReadLocalJSONFile<AcquisitionReceipt>(resolvePath(directory, "receipt.json"))

			copies.push({ installationID: installation.id, artifactID: artifact.artifactID, path, manifest, receipt })
		}
	}

	return copies
}

async function observeArtifactTerms(
	dataRoot: PathBuilderLike,
	manifest: DataReleaseManifest | null,
	artifacts: readonly BundleArtifact[]
): Promise<ArtifactTermsObservation[]> {
	const observations: ArtifactTermsObservation[] = []

	for (const artifact of artifacts) {
		const localAbsPath = bundleArtifactPath(dataRoot, artifact)
		const existing = await existingLocalPath(dataRoot, manifest, artifact, localAbsPath)

		if (!existing) {
			observations.push({ path: localAbsPath, state: "absent" })

			continue
		}

		const probed = probeManifest(existing)

		if (probed.error) {
			observations.push({ path: existing, state: "unreadable", error: probed.error })
		} else if (!probed.manifest) {
			observations.push({ path: existing, state: "unmanifested" })
		} else {
			observations.push({
				path: existing,
				state: "recorded",
				tier: probed.manifest.tier,
				license: probed.manifest.license,
			})
		}
	}

	return observations
}

/**
 * Every refused obligation in the bundle's recorded expression and in each copy on disk.
 */
function bundleRefusals(
	bundle: DataBundle,
	observations: readonly ArtifactTermsObservation[],
	installed: readonly InstalledCopy[],
	refuse: readonly ObligationRefusal[]
): PlannedRefusal[] {
	const refusals: PlannedRefusal[] = obligationFindings(bundle.rights.expression, refuse).map((finding) => ({
		subject: `recorded expression ${bundle.rights.expression}`,
		finding,
	}))

	for (const observation of observations) {
		if (observation.state !== "recorded" || !observation.license) continue

		for (const finding of obligationFindings(observation.license, refuse)) {
			refusals.push({ subject: `${observation.path} records ${observation.license}`, finding })
		}
	}

	for (const copy of installed) {
		for (const finding of obligationFindings(copy.manifest.license, refuse)) {
			refusals.push({ subject: `${copy.path} records ${copy.manifest.license}`, finding })
		}
	}

	return refusals
}

/**
 * Whether a dependency bundle is installed: selected in the catalog, or present at its conventional paths.
 */
async function dependencySatisfied(
	dataRoot: string,
	catalog: LayerCatalog,
	manifest: DataReleaseManifest | null,
	bundle: DataBundle
): Promise<boolean> {
	for (const artifact of resolveBundleArtifacts(bundle, manifest)) {
		const conventional = bundleArtifactPath(dataRoot, artifact)

		if (!(await existingLocalPath(dataRoot, manifest, artifact, conventional, bundle, catalog))) return false
	}

	return true
}

/**
 * Plan an installation of published bundles.
 *
 * @throws {@link UnreadableArtifactError} when the selection, an installation record
 * or the release manifest exists and cannot be read.
 * An unreadable installation is never planned as an empty one.
 */
export async function planInstallation(request: InstallationRequest): Promise<InstallationPlan> {
	const dataRoot = resolvePath(request.dataRoot.toString())
	const registry = request.registry ?? BUNDLES
	const releases = await readReleaseManifest(dataRoot)
	const catalog = await LayerCatalog.read(dataRoot)
	const copies = await readInstalledCopies(dataRoot)
	const refuse = request.refuse ?? []
	const requested = new Set(request.bundles)
	const bundles: PlannedBundle[] = []

	for (const name of request.bundles) {
		const bundle = registry[name] ?? null

		const planned: PlannedBundle = {
			name,
			bundle,
			entry: null,
			problems: [],
			terms: [],
			artifactTerms: [],
			refusals: [],
			access: null,
			missingDependencies: [],
			artifacts: [],
		}

		bundles.push(planned)

		if (!bundle) {
			planned.problems.push(`unknown bundle; known bundles: ${Object.keys(registry).join(", ")}`)

			continue
		}

		planned.terms = describeBundleRights(bundle)

		const artifacts = filterArtifacts(resolveBundleArtifacts(bundle, releases), request.only ?? null)

		if (!artifacts.length) {
			planned.problems.push(`no artifacts matched --only ${request.only}`)

			continue
		}

		const entry = availableDataEntry({ ...bundle, artifacts })

		planned.entry = entry

		const observations = await observeArtifactTerms(dataRoot, releases, artifacts)
		const ownCopies = copies.filter((copy) => artifacts.some((a) => a.remotePath === copy.receipt?.remotePath))

		planned.artifactTerms = describeArtifactTerms(bundle, observations)
		planned.refusals = bundleRefusals(bundle, observations, ownCopies, refuse)

		if (bundle.access === "licensed") {
			planned.access = licensedPullDecision(bundle, request.configuredKey ? await request.configuredKey() : null)
		}

		for (const dependency of bundle.dependencies ?? []) {
			const dependencyBundle = registry[dependency]

			if (requested.has(dependency)) continue

			if (!dependencyBundle || !(await dependencySatisfied(dataRoot, catalog, releases, dependencyBundle))) {
				planned.missingDependencies.push(dependency)
			}
		}

		for (const [index, artifact] of artifacts.entries()) {
			const available = entry.artifacts[index]!
			const scope = selectionScopeOf(available)
			const conventional = bundleArtifactPath(dataRoot, artifact)
			const url = artifactURL(artifact, request.host)
			const selected = catalog.selection ? selectedSources(catalog.selection, available.role, scope) : []
			const copy = copies.find((candidate) => candidate.receipt?.remotePath === artifact.remotePath) ?? null
			const isSelected = copy ? selected.some((source) => source.artifactID === copy.artifactID) : false

			const base = {
				bundle: name,
				artifact,
				available,
				url,
				installed: null,
				existingPath: null,
				replaces: selected,
			}

			if (entry.activation === "selection") {
				const destination = catalogPaths(dataRoot).root("db", available.role).toString()

				if (copy && !request.force) {
					planned.artifacts.push({
						...base,
						action: isSelected ? PlannedAction.Reuse : PlannedAction.Activate,
						installed: copy,
						destination: copy.path,
						replaces: isSelected ? [] : selected,
					})

					continue
				}

				const existing = await existingLocalPath(dataRoot, releases, artifact, conventional)

				// A file at the conventional path keeps serving while its role and scope have no selected source.
				// Every installation made before the catalog reads that way.
				if (existing && !selected.length && !request.force) {
					planned.artifacts.push({
						...base,
						action: PlannedAction.Present,
						existingPath: existing,
						destination: existing,
						replaces: [],
					})

					continue
				}

				planned.artifacts.push({ ...base, action: PlannedAction.Download, destination })

				continue
			}

			const existing = await existingLocalPath(dataRoot, releases, artifact, conventional)

			if (existing && !request.force) {
				planned.artifacts.push({
					...base,
					action: PlannedAction.Present,
					existingPath: existing,
					destination: existing,
					replaces: [],
				})
			} else {
				planned.artifacts.push({ ...base, action: PlannedAction.Download, destination: conventional, replaces: [] })
			}
		}
	}

	const downloads = bundles.flatMap((bundle) =>
		bundle.problems.length || bundle.refusals.length || bundle.access?.kind === "refused"
			? []
			: bundle.artifacts.filter((artifact) => artifact.action === PlannedAction.Download)
	)

	const recordedBytes = downloads.reduce(
		(sum, artifact) => sum + (artifact.available.size.basis === SizeBasis.Unknown ? 0 : artifact.available.size.bytes),
		0
	)

	const unknownCount = downloads.filter((artifact) => artifact.available.size.basis === SizeBasis.Unknown).length
	const verified = downloads.every((artifact) => artifact.available.size.basis === SizeBasis.Verified)

	let disk: FilesystemSpace | null = null
	let diskError: string | null = null

	try {
		disk = await readFilesystemSpace(dataRoot)
	} catch (error) {
		diskError = `the free space under ${dataRoot} could not be read: ${(error as Error).message}`
	}

	return {
		dataRoot,
		basedOnGeneration: catalog.generation,
		bundles,
		transfer: {
			recordedBytes,
			basis: downloads.length && verified ? SizeBasis.Verified : SizeBasis.Estimated,
			unknownCount,
		},
		disk,
		diskError,
		fitsOnDisk: disk && !unknownCount ? recordedBytes <= disk.availableBytes : null,
	}
}

/**
 * The plan's per-artifact and summary lines, for the dry run and for setup.
 */
export function describePlannedArtifact(artifact: PlannedArtifact): string {
	const size =
		artifact.available.size.basis === SizeBasis.Unknown
			? "size unknown"
			: `${ByteFormatter.formatSI(artifact.available.size.bytes)} ${artifact.available.size.basis}`

	const replaces = artifact.replaces.length
		? `; activation replaces ${artifact.replaces.map((source) => source.artifactID).join(", ")} for ${artifact.available.role}`
		: ""

	switch (artifact.action) {
		case PlannedAction.Download:
			return `download ${size} ${artifact.url} → ${artifact.destination}${replaces}`
		case PlannedAction.Reuse:
			return `installed and selected at ${artifact.destination}; verified before reuse, nothing transferred`
		case PlannedAction.Activate:
			return `installed at ${artifact.destination} and not selected; verified, then selected${replaces}`
		case PlannedAction.Present:
			return `already present (${artifact.existingPath}); skipped`
	}
}

/**
 * The plan's summary: transfer size and its basis, the disk needed against the
 * disk available, and missing dependencies.
 */
export function describePlanSummary(plan: InstallationPlan): string[] {
	const lines: string[] = []
	const { transfer } = plan

	const unknown = transfer.unknownCount ? ` and ${transfer.unknownCount} artifact(s) of unknown size` : ""

	lines.push(`transfer: ${ByteFormatter.formatSI(transfer.recordedBytes)} (${transfer.basis})${unknown}`)

	if (plan.disk) {
		const fits =
			plan.fitsOnDisk == null ? "cannot be compared while a size is unknown" : plan.fitsOnDisk ? "fits" : "does not fit"

		lines.push(
			`disk: ${ByteFormatter.formatSI(plan.disk.availableBytes)} available on the filesystem of ${plan.disk.measuredAt}; the transfer ${fits}`
		)
	} else if (plan.diskError) {
		lines.push(`disk: ${plan.diskError}`)
	}

	for (const bundle of plan.bundles) {
		for (const dependency of bundle.missingDependencies) {
			lines.push(`${bundle.name} needs ${dependency}, which is not installed: mailwoman data pull ${dependency}`)
		}
	}

	return lines
}
