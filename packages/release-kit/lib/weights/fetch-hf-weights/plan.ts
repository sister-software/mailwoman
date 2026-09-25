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
 * Says where one declared artifact comes from: a Hugging Face bucket object under a
 * versioned directory, or a file already committed to the repo.
 *
 * Bucket objects are stored flat by basename, so an overlay's artifacts live under the
 * base locale's directory while a character-path family has its own.
 */
export type ArtifactOrigin = { kind: "hf"; remoteName: string; base: string } | { kind: "repo"; sourcePath: string }

/**
 * One artifact a weights package declares in `files` that no `git archive` of this repo can supply.
 */
export interface WeightsArtifactPlan {
	/**
	 * The repo-relative workspace path, always under `packages/`, which the destination path inherits.
	 */
	workspace: string

	/**
	 * The `files` entry verbatim, which is also the bucket object's name because the bucket is staged flat.
	 */
	filename: string
	origin: ArtifactOrigin

	/**
	 * The md5 a release model card declares for this filename.
	 *
	 * Absence means no card declares one, and the report lists such files in `checksumUndeclared`.
	 */
	expectedMD5?: string
}

/**
 * What a materialization did, for the caller's receipt.
 */
export interface HFMaterializationReport {
	version: string

	/**
	 * The base locale's versioned bucket directory; character-path families read
	 * from their own directories beside it.
	 */
	base: string

	/**
	 * Distinct bucket objects downloaded, fewer than `written` whenever several
	 * packages ship the same artifact.
	 */
	downloaded: number

	/**
	 * Destination files written across every workspace, including files copied from the repo.
	 */
	written: number
	bytes: number

	/**
	 * Artifacts whose bytes matched a model card's declared md5.
	 */
	checksumVerified: number

	/**
	 * Filenames no release model card declares an md5 for, listed by name
	 * so an empty check set is not mistaken for a verified fetch.
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
 * Returns the one release locale whose package declares `model.onnx`, which is the
 * bucket directory every Latin artifact is staged under.
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
 * Reads the model version a release publishes from the base locale's model-card `version`.
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
 * Lists the bucket objects the base model card declares that never go into a tarball,
 * currently the Fisher artifact and its sidecar.
 *
 * They are probed with the rest so a half-staged release is refused,
 * since nothing at runtime would notice them missing.
 */
export async function distributionOnlyRemoteNames(repoRoot: PathBuilderLike, baseLocale: string): Promise<string[]> {
	const cardPath = resolvePath(repoRoot, weightsWorkspace(baseLocale), "model-card.json")

	const card = await readLocalJSONFile<{ fisher_artifact?: { file?: string; sidecar?: string } }>(cardPath)

	const declared = [card.fisher_artifact?.file, card.fisher_artifact?.sidecar]

	return declared.filter(isPresent)
}

/**
 * Returns the public bucket URL directory for the base locale at `version`,
 * honoring `HF_BUCKET_RESOLVE_URL` as a mirror override.
 */
export async function hfVersionBase(repoRoot: PathBuilderLike, version: string): Promise<string> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)

	return `${await hfResolveRoot(repoRoot)}/${baseLocale}/v${version}`
}

/**
 * Returns the bucket URL directory for a character-path family at `version`,
 * which sits beside the Latin base's directory.
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
 * but the checkout does not track, with its origin and expected MD5.
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
 * Plans the untracked artifacts of one character-path family workspace,
 * read from the family's own versioned bucket directory.
 *
 * Latin model cards are not consulted, because a family's `model.onnx` is a
 * different graph under the same name.
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
