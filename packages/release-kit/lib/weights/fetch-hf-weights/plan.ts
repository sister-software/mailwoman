#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize a release's weights artifacts from the PUBLIC Hugging Face bucket — the `--source hf`
 *   half of the #1894 preflight, and the recipe `.github/workflows/publish.yml` now calls in place of
 *   the curl-and-cp block it used to carry inline. ONE recipe, two callers: the preflight points it at
 *   a staging tree, the publish job points it at the checkout. `copy-weights.ts` is the same shape for
 *   the operator's data root; both take a destination root and touch nothing else.
 *
 *   WHAT IS FETCHED IS DERIVED, NOT LISTED. A `neural-weights-<locale>` package's `files` array is its
 *   author stating which artifacts the tarball carries, and `git ls-files` says which of those a
 *   checkout already has; the difference is exactly the set something must materialize — the same
 *   predicate `verify-tarball.ts` refuses a publish over (`literalFilesEntries`, shared with it). The
 *   v9.2.0 release published 49 of 51 workspaces before that audit refused
 *   `@mailwoman/neural-weights-en-au`, whose four declared lexicons the YAML's hand-maintained copy
 *   list did not name. A derived list cannot fall behind a manifest that way.
 *
 *   NO CREDENTIALS, NO WRITES ANYWHERE BUT THE DESTINATION ROOT. The bucket is public — the same files
 *   the browser demo loads. Nothing here writes to Hugging Face, npm, git, or R2.
 */

import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { trackedFiles } from "@mailwoman/core/git"
import { readReleaseConfig, repoCommittedSoftFeedSources } from "@mailwoman/core/release-config"
import { resolvePath } from "path-ts"

import { $private } from "#env/index"
import { literalFilesEntries } from "#pack/verify-tarball"
import { releaseWorkspaces } from "#release/stage"
/**
 * The bucket's resolve root, when `$private.HF_BUCKET_RESOLVE_URL` does not name one. The bucket name itself comes from
 * `release.config.json`'s `assets.hfBucket`, so a bucket move is a config edit rather than a code edit.
 */
const DEFAULT_HF_RESOLVE_ROOT = "https://huggingface.co/buckets"

/**
 * The artifact that identifies the BASE weights package. Every overlay shares this file byte for byte and declares none
 * of its own, which is what makes the base self-contained — and what makes it derivable rather than spelled `en-us`.
 */
const MODEL_FILENAME = "model.onnx"

/**
 * Where one declared artifact comes from.
 *
 * `hf` names a bucket object by basename under `base`, the versioned bucket directory it is read from: `mailwoman
 * release hf` uploads with a single `--locale`, flat, so an overlay's `pair-index-de.bin` lives under the BASE locale's
 * version directory rather than its own, and a character-path family (`cjk`) lives under its OWN directory, because its
 * `model.onnx` shares a basename with the Latin base's and is not the same bytes. `repo` names a committed file the
 * checkout already carries (see `repoCommittedSoftFeedSources`).
 */
export type ArtifactOrigin = { kind: "hf"; remoteName: string; base: string } | { kind: "repo"; sourcePath: string }

/**
 * One artifact a weights package declares in `files` that no `git archive` of this repo can supply.
 */
export interface WeightsArtifactPlan {
	/**
	 * Repo-relative workspace path — always under `packages/`, which the destination inherits. The v9.2.0 release's first
	 * dispatch died because the YAML wrote `"$ws/…"` after the regroup, so this is the field the fixture pins.
	 */
	workspace: string
	/**
	 * The `files` entry verbatim: the name the tarball must carry, which is not always the source's basename elsewhere in
	 * the pipeline but is here, because the bucket is staged flat by shipped name.
	 */
	filename: string
	origin: ArtifactOrigin
	/**
	 * The md5 a release model card declares for this filename, when one does. Absent means NO CARD DECLARES ONE — never
	 * "the bytes are unverified because the check was skipped"; the report separates the two.
	 */
	expectedMD5?: string
}

/**
 * What a materialization did, for the caller's receipt.
 */
export interface HFMaterializationReport {
	version: string
	/**
	 * The versioned bucket directory every `hf` artifact was read from.
	 */
	base: string
	/**
	 * Distinct bucket objects downloaded — fewer than `written` whenever several packages ship the same artifact.
	 */
	downloaded: number
	/**
	 * Destination files written, across every workspace.
	 */
	written: number
	bytes: number
	/**
	 * Artifacts whose bytes were checked against a model card's declared md5.
	 */
	checksumVerified: number
	/**
	 * Filenames no release model card declares an md5 for. Reported by name because a silent "0 mismatches" over an empty
	 * check set reads exactly like a verified fetch.
	 */
	checksumUndeclared: string[]
}

/**
 * Read a workspace's `package.json`.
 */
async function readWorkspaceManifest(repoRoot: string, workspace: string): Promise<{ files?: unknown }> {
	const manifestPath = resolvePath(repoRoot, workspace, "package.json")

	return readLocalJSONFile<{ files?: unknown }>(manifestPath)
}

/**
 * The workspace path for a release locale. The `packages/` prefix lives here once, so a future regroup moves one line
 * rather than every string that named a workspace.
 */
function weightsWorkspace(locale: string): string {
	return `packages/neural-weights-${locale}`
}

/**
 * Which of these workspaces' files git already tracks — i.e. what `stageReleaseTree`'s `git archive` puts in the
 * staging tree for free (`model-card.json`, `calibration.json`, `README.md`, the sources).
 */
async function trackedWorkspaceFiles(repoRoot: string, workspaces: readonly string[]): Promise<Set<string>> {
	return new Set(await trackedFiles(repoRoot, [...workspaces]))
}

/**
 * The md5s the release model cards declare, keyed by shipped filename.
 *
 * Merged across every release weights card rather than read from the base alone: the base's card covers the artifacts
 * every overlay copies (`model.onnx`, the two bundle lexicons), and an overlay is free to declare its own. Two cards
 * declaring DIFFERENT md5s for one filename is refused outright — one bucket object cannot satisfy both, and a fetch
 * has no basis to choose.
 */
async function declaredChecksums(repoRoot: string, workspaces: readonly string[]): Promise<Map<string, string>> {
	const declared = new Map<string, string>()

	for (const workspace of workspaces) {
		const cardPath = resolvePath(repoRoot, workspace, "model-card.json")

		if (!(await pathExists(cardPath))) continue

		const card = await readLocalJSONFile<{ files_md5?: Record<string, unknown> }>(cardPath)

		for (const [filename, md5] of Object.entries(card.files_md5 ?? {})) {
			// `$comment` keys carry the block's prose, not a checksum.
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
 * The locale whose package ships the model itself — the BASE, and the directory every artifact is staged under.
 */
export async function resolveBaseLocale(repoRoot: string, locales: readonly string[]): Promise<string> {
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
 * The model version a release publishes: the base package's model-card `version`, which is exactly what the publish
 * workflow read out of that card before this script existed.
 */
export async function readBaseModelVersion(repoRoot: string): Promise<string> {
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
 * Artifacts the base model card declares that ride the bucket but are NEVER fetched into a tarball — today the #1354
 * Fisher consolidation pair (`fisher_artifact.file` + its `.sidecar`).
 *
 * The bundle contract says a weights release ships its Fisher, so every fine-tune off that base can apply the EWC
 * brake; the runtime never reads it and npm never carries it, which is exactly why nothing else would notice its
 * absence. HEAD-probed with the rest so a half-staged release is refused before it publishes. BOTH halves are probed:
 * the YAML this replaces checked only `file`, and a declared sidecar that never uploaded would have passed.
 */
export async function distributionOnlyRemoteNames(repoRoot: string, baseLocale: string): Promise<string[]> {
	const cardPath = resolvePath(repoRoot, weightsWorkspace(baseLocale), "model-card.json")

	const card = await readLocalJSONFile<{ fisher_artifact?: { file?: unknown; sidecar?: unknown } }>(cardPath)

	const declared = [card.fisher_artifact?.file, card.fisher_artifact?.sidecar]

	return declared.filter((name): name is string => typeof name === "string" && name.length > 0)
}

/**
 * The versioned bucket directory for `version`.
 *
 * `$private.HF_BUCKET_RESOLVE_URL` replaces the `<host>/<bucket>/resolve` prefix wholesale, for a mirror or a local
 * fixture server; unset, the prefix is built from `release.config.json`'s `assets.hfBucket`. Nothing about either path
 * needs a token — the bucket is public, and a credential here would only hide the day it stops being public.
 */
export async function hfVersionBase(repoRoot: string, version: string): Promise<string> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)

	return `${await hfResolveRoot(repoRoot)}/${baseLocale}/v${version}`
}

/**
 * The versioned bucket directory of a character-path family: `<root>/<family>/v<version>`, the family's own card
 * version, beside the Latin base's directory rather than inside it.
 */
export async function hfFamilyBase(repoRoot: string, family: string, version: string): Promise<string> {
	return `${await hfResolveRoot(repoRoot)}/${family}/v${version}`
}

/**
 * The `<host>/<bucket>/resolve` prefix every versioned directory hangs off.
 */
async function hfResolveRoot(repoRoot: string): Promise<string> {
	const config = await readReleaseConfig(repoRoot)
	const bucket = config.assets?.hfBucket

	if (!bucket && !$private.HF_BUCKET_RESOLVE_URL) {
		throw new Error(
			"fetch-hf-weights: release.config.json declares no assets.hfBucket and HF_BUCKET_RESOLVE_URL is unset — " +
				"there is no bucket to read."
		)
	}

	// Trailing slashes are stripped rather than trusted: the override is operator-supplied configuration and the lab's
	// copy ends in one, which would otherwise put an empty path segment between the root and the locale.
	const configured = $private.HF_BUCKET_RESOLVE_URL ?? `${DEFAULT_HF_RESOLVE_ROOT}/${bucket}/resolve`

	return configured.replace(/\/+$/, "")
}

/**
 * Every artifact a release's weights packages declare and a checkout does not carry.
 *
 * Derived from three machine-readable owners and nothing else: `release.config.json` names the locales, each package's
 * `files` array names its artifacts, and `git ls-files` says which are already here.
 */
export async function planWeightsMaterialization(
	repoRoot: string,
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

	// Character-path families (`release.config.json` `charWeights`): each is its own base, staged under its own bucket
	// directory at its own card version, verified against its own card — and planned only once its workspace is in the
	// release list, because a planned object the bucket does not hold refuses every release until it is staged.
	const released = new Set(await releaseWorkspaces(repoRoot))

	for (const [family, recipe] of Object.entries(config.charWeights ?? {})) {
		const workspace = weightsWorkspace(family)

		if (!released.has(workspace)) continue

		plans.push(...(await planCharFamilyArtifacts(repoRoot, family, workspace)))

		// A family's data-only overlays live in the family's directory too: their objects (the locale FSTs) are
		// staged beside the graph with `--fsts`, and their own cards declare whatever md5s they have.
		for (const overlay of recipe.overlays ?? []) {
			const overlayWorkspace = weightsWorkspace(overlay)

			if (!released.has(overlayWorkspace)) continue

			plans.push(...(await planCharFamilyArtifacts(repoRoot, family, overlayWorkspace)))
		}
	}

	return plans
}

/**
 * The `files` entries of `workspace` that git does not track — what the bucket (or the checkout's soft-feed sources)
 * has to supply. A nested entry is refused here rather than reported missing by the tarball audit after most of the
 * release has published.
 */
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
 * The plans of one character-path family: its untracked `files` entries, read from `<root>/<family>/v<card version>`
 * and checked against the family's own `files_md5`. The Latin cards are not consulted — a family's `model.onnx` is a
 * different graph under the same name.
 */
export async function planCharFamilyArtifacts(
	repoRoot: string,
	family: string,
	workspace: string
): Promise<WeightsArtifactPlan[]> {
	// The directory is named by the FAMILY card's version, for the base and for every overlay that inherits it.
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
