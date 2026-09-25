#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { trackedFiles } from "@mailwoman/core/git"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isPresent } from "@mailwoman/core/objects"
import { readReleaseConfig, repoCommittedSoftFeedSources } from "@mailwoman/core/release-config"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { $private } from "#env/index"
import { literalFilesEntries } from "#pack/verify-tarball"
import { releaseWorkspaces } from "#release/stage"

const DEFAULT_HF_RESOLVE_ROOT = "https://huggingface.co/buckets"

const MODEL_FILENAME = "model.onnx"

/**
 * The source of one declared artifact.
 *
 * It is either a Hugging Face bucket object under a versioned directory or a file committed to the repo.
 *
 * Bucket objects are stored flat by basename.
 * An overlay's artifacts live under the base locale's directory, and each
 * character-path family has its own directory.
 */
export type ArtifactOrigin = { kind: "hf"; remoteName: string; base: string } | { kind: "repo"; sourcePath: string }

/**
 * One artifact that a weights package declares in `files` and the repo does not track.
 */
export interface WeightsArtifactPlan {
	/**
	 * The repo-relative workspace path under `packages/`.
	 * The destination path uses the same path.
	 */
	workspace: string

	/**
	 * The verbatim `files` entry.
	 *
	 * It is also the bucket object's name because the bucket is staged flat.
	 */
	filename: string
	origin: ArtifactOrigin

	/**
	 * The MD5 that a release model card declares for this file.
	 * The report lists files without one in `checksumUndeclared`.
	 */
	expectedMD5?: string
}

/**
 * The counts and file lists that a materialization reports to its caller.
 */
export interface HFMaterializationReport {
	version: string

	/**
	 * The base locale's versioned bucket directory.
	 *
	 * Character-path families read from their own directories beside it.
	 */
	base: string

	/**
	 * The number of distinct bucket objects downloaded.
	 *
	 * It is lower than `written` when several packages ship the same artifact.
	 */
	downloaded: number

	/**
	 * The number of destination files written across every workspace, including files copied from the repo.
	 */
	written: number
	bytes: number

	/**
	 * The number of artifacts whose bytes matched a model card's declared MD5.
	 */
	checksumVerified: number

	/**
	 * The file names that no release model card declares an MD5 for.
	 */
	checksumUndeclared: string[]
}

async function readWorkspaceManifest(repoRoot: PathBuilderLike, workspace: string): Promise<{ files?: unknown }> {
	return readPackageJSON<{ files?: unknown }>(resolvePath(repoRoot, workspace, "package.json"))
}

function weightsWorkspace(locale: string): string {
	return `packages/neural-weights-${locale}`
}

async function trackedWorkspaceFiles(repoRoot: PathBuilderLike, workspaces: readonly string[]): Promise<Set<string>> {
	return new Set(await trackedFiles(repoRoot, [...workspaces]))
}

async function declaredChecksums(
	repoRoot: PathBuilderLike,
	workspaces: readonly string[]
): Promise<Map<string, string>> {
	const declared = new Map<string, string>()

	for (const workspace of workspaces) {
		const cardPath = resolvePath(repoRoot, workspace, "model-card.json")

		if (!(await pathExists(cardPath))) continue

		const card = await readLocalJSONFile<{ files_md5?: Record<string, unknown> }>(cardPath)

		for (const [filename, md5] of Object.entries(card.files_md5 ?? {})) {
			if (filename.startsWith("$") || typeof md5 !== "string") continue

			const existing = declared.get(filename)

			if (existing && existing !== md5) {
				throw new Error(
					`fetch-hf-weights: release model cards disagree about ${filename} — ${existing} vs ${md5} (${workspace}). ` +
						"One bucket object cannot satisfy both; fix the cards before staging."
				)
			}

			declared.set(filename, md5)
		}
	}

	return declared
}

/**
 * Returns the one release locale whose package declares `model.onnx`.
 *
 * Every Latin artifact is staged under that locale's bucket directory.
 *
 * @throws When zero or several release locales declare the model.
 */
export async function resolveBaseLocale(repoRoot: PathBuilderLike, locales: readonly string[]): Promise<string> {
	const carriers: string[] = []

	for (const locale of locales) {
		const manifest = await readWorkspaceManifest(repoRoot, weightsWorkspace(locale))

		if (literalFilesEntries(manifest.files).includes(MODEL_FILENAME)) {
			carriers.push(locale)
		}
	}

	if (carriers.length !== 1) {
		throw new Error(
			`fetch-hf-weights: expected exactly one release locale to declare ${MODEL_FILENAME} in its files array, ` +
				`found ${carriers.length} (${carriers.join(", ") || "none"}). The bucket stages every artifact flat under the ` +
				"base locale's version directory, so the base must be unambiguous."
		)
	}

	return carriers[0]!
}

/**
 * Reads the release's model version from the `version` field of the base locale's model card.
 */
export async function readBaseModelVersion(repoRoot: PathBuilderLike): Promise<string> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)
	const cardPath = resolvePath(repoRoot, weightsWorkspace(baseLocale), "model-card.json")
	const card = await readLocalJSONFile<{ version?: unknown }>(cardPath)

	if (typeof card.version !== "string") {
		throw new TypeError(`fetch-hf-weights: ${cardPath} declares no string "version" — cannot name a bucket directory.`)
	}

	return card.version
}

/**
 * Lists the bucket objects that the base model card declares and no tarball ships,
 * such as the Fisher artifact and its sidecar.
 *
 * The fetch probes them with the other objects because no runtime check would detect their absence.
 */
export async function distributionOnlyRemoteNames(repoRoot: PathBuilderLike, baseLocale: string): Promise<string[]> {
	const cardPath = resolvePath(repoRoot, weightsWorkspace(baseLocale), "model-card.json")

	const card = await readLocalJSONFile<{ fisher_artifact?: { file?: string; sidecar?: string } }>(cardPath)

	const declared = [card.fisher_artifact?.file, card.fisher_artifact?.sidecar]

	return declared.filter(isPresent)
}

/**
 * Returns the public bucket URL directory for the base locale at `version`.
 * `HF_BUCKET_RESOLVE_URL` overrides the bucket root.
 */
export async function hfVersionBase(repoRoot: PathBuilderLike, version: string): Promise<string> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)

	return `${await hfResolveRoot(repoRoot)}/${baseLocale}/v${version}`
}

/**
 * Returns the bucket URL directory for a character-path family at `version`.
 */
export async function hfFamilyBase(repoRoot: PathBuilderLike, family: string, version: string): Promise<string> {
	return `${await hfResolveRoot(repoRoot)}/${family}/v${version}`
}

async function hfResolveRoot(repoRoot: PathBuilderLike): Promise<string> {
	const config = await readReleaseConfig(repoRoot)
	const bucket = config.assets?.hfBucket

	if (!bucket && !$private.HF_BUCKET_RESOLVE_URL) {
		throw new Error(
			"fetch-hf-weights: release.config.json declares no assets.hfBucket and HF_BUCKET_RESOLVE_URL is unset — " +
				"there is no bucket to read."
		)
	}

	const configured = $private.HF_BUCKET_RESOLVE_URL ?? `${DEFAULT_HF_RESOLVE_ROOT}/${bucket}/resolve`

	return configured.replace(/\/+$/, "")
}

/**
 * Plans every artifact that a release's weights packages declare in `files`
 * and the checkout does not track.
 * Each plan carries the artifact's origin and expected MD5.
 */
export async function planWeightsMaterialization(
	repoRoot: PathBuilderLike,
	options: { version?: string } = {}
): Promise<WeightsArtifactPlan[]> {
	const config = await readReleaseConfig(repoRoot)
	const repoSources = repoCommittedSoftFeedSources(repoRoot, config.softFeed ?? {})
	const workspaces = config.locales.map((locale) => weightsWorkspace(locale))
	const tracked = await trackedWorkspaceFiles(repoRoot, workspaces)
	const checksums = await declaredChecksums(repoRoot, workspaces)
	const base = await hfVersionBase(repoRoot, options.version ?? (await readBaseModelVersion(repoRoot)))
	const plans: WeightsArtifactPlan[] = []

	for (const workspace of workspaces) {
		const manifest = await readWorkspaceManifest(repoRoot, workspace)

		for (const filename of untrackedDeclaredArtifacts(workspace, manifest, tracked)) {
			const sourcePath = repoSources.get(filename)
			const expectedMD5 = checksums.get(filename)

			plans.push({
				workspace,
				filename,
				origin: sourcePath ? { kind: "repo", sourcePath } : { kind: "hf", remoteName: filename, base },
				...(expectedMD5 ? { expectedMD5 } : {}),
			})
		}
	}

	const released = new Set(await releaseWorkspaces(repoRoot))

	for (const [family, recipe] of Object.entries(config.charWeights ?? {})) {
		const workspace = weightsWorkspace(family)

		if (!released.has(workspace)) continue

		plans.push(...(await planCharFamilyArtifacts(repoRoot, family, workspace)))

		for (const overlay of recipe.overlays ?? []) {
			const overlayWorkspace = weightsWorkspace(overlay)

			if (!released.has(overlayWorkspace)) continue

			plans.push(...(await planCharFamilyArtifacts(repoRoot, family, overlayWorkspace)))
		}
	}

	return plans
}

function untrackedDeclaredArtifacts(
	workspace: string,
	manifest: { files?: unknown },
	tracked: ReadonlySet<string>
): string[] {
	const artifacts: string[] = []

	for (const filename of literalFilesEntries(manifest.files)) {
		if (tracked.has(`${workspace}/${filename}`)) continue

		if (filename.includes("/")) {
			throw new Error(
				`fetch-hf-weights: ${workspace} declares the untracked nested entry "${filename}". The bucket stages ` +
					"artifacts flat by shipped name and this recipe has no rule for a nested one — add one here rather than " +
					"letting the tarball audit report it missing after 49 packages have published."
			)
		}

		artifacts.push(filename)
	}

	return artifacts
}

/**
 * Plans the untracked artifacts of one character-path family workspace from
 * the family's versioned bucket directory.
 *
 * The plan reads checksums only from the family workspace, because a family's `model.onnx`
 * is a different graph from the Latin one with the same name.
 */
export async function planCharFamilyArtifacts(
	repoRoot: PathBuilderLike,
	family: string,
	workspace: string
): Promise<WeightsArtifactPlan[]> {
	const cardPath = resolvePath(repoRoot, weightsWorkspace(family), "model-card.json")
	const card = await readLocalJSONFile<{ version?: unknown }>(cardPath)

	if (typeof card.version !== "string") {
		throw new TypeError(`fetch-hf-weights: ${cardPath} declares no string "version" — cannot name a bucket directory.`)
	}

	const base = await hfFamilyBase(repoRoot, family, card.version)
	const checksums = await declaredChecksums(repoRoot, [workspace])
	const tracked = await trackedWorkspaceFiles(repoRoot, [workspace])
	const manifest = await readWorkspaceManifest(repoRoot, workspace)

	return untrackedDeclaredArtifacts(workspace, manifest, tracked).map((filename) => {
		const expectedMD5 = checksums.get(filename)

		return {
			workspace,
			filename,
			origin: { kind: "hf", remoteName: filename, base },
			...(expectedMD5 ? { expectedMD5 } : {}),
		}
	})
}
