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
 *   v9.2.0 cut published 49 of 51 workspaces before that audit refused
 *   `@mailwoman/neural-weights-en-au`, whose four declared lexicons the YAML's hand-maintained copy
 *   list did not name. A derived list cannot fall behind a manifest that way.
 *
 *   NO CREDENTIALS, NO WRITES ANYWHERE BUT THE DESTINATION ROOT. The bucket is public — the same files
 *   the browser demo loads. Nothing here writes to Hugging Face, npm, git, or R2.
 */

import { APIClient } from "@mailwoman/core/api"
import { $private } from "@mailwoman/core/env"
import { pathExists, readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, removePathIfPresent, writeLocalFile } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"
import { runIfScript } from "@mailwoman/core/scripting"
import { md5Hex, repoRootPath } from "@mailwoman/core/utils"
import { resolve } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"
import { TextSpliterator } from "spliterator"
import { $ } from "zx"

import { literalFilesEntries } from "./verify-tarball.ts"
import { readReleaseConfig, repoCommittedSoftFeedSources } from "./weights-recipe.ts"

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
 * `hf` names a bucket object by basename: `mailwoman release hf` uploads with a single `--locale`, flat, so an
 * overlay's `pair-index-de.bin` lives under the BASE locale's version directory rather than its own. `repo` names a
 * committed file the checkout already carries (see `repoCommittedSoftFeedSources`).
 */
export type ArtifactOrigin = { kind: "hf"; remoteName: string } | { kind: "repo"; sourcePath: string }

/**
 * One artifact a weights package declares in `files` that no `git archive` of this repo can supply.
 */
export interface WeightsArtifactPlan {
	/**
	 * Repo-relative workspace path — always under `packages/`, which the destination inherits. The v9.2.0 cut's first
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
 * The bucket client.
 *
 * The house rule routes API REQUESTS through `APIClient` and exempts multi-gigabyte file transfers, where a buffered
 * body is untenable and response caching is nonsense. These objects sit on the API side of that line: the largest is
 * `model.onnx` at 39,419,629 bytes and the whole set is under ~70 MB (measured 2026-08-25 against the v9.1.0
 * directory), each one is md5-checked after arrival, and each is fetched exactly once per run — so a buffered body
 * costs one artifact's worth of memory and a stream would buy nothing. What `APIClient` does buy is the reason the YAML
 * this replaces passed `--retry 6 --retry-all-errors` to every curl: Hugging Face throttles the public bucket from CI,
 * and a 429 read as a missing artifact is the one answer that would have a release believe its weights were never
 * staged.
 *
 * No pacer, deliberately. One run is a score of concurrent HEADs and then sequential whole-object GETs against a public
 * CDN the browser demo already reads at higher concurrency; retry is the only rate control this path has ever needed,
 * and an invented interval would be a number no measurement supports.
 */
const bucketClient = new APIClient({ displayName: "release-hf-weights", retry: true })

/**
 * Read a workspace's `package.json`.
 */
async function readWorkspaceManifest(repoRoot: string, workspace: string): Promise<{ files?: unknown }> {
	const manifestPath = resolve(repoRoot, workspace, "package.json")

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
function trackedFiles(repoRoot: string, workspaces: readonly string[]): Set<string> {
	const listing = $.sync({ cwd: repoRoot })`git ls-files -- ${workspaces}`

	return new Set([...TextSpliterator.from(listing.stdout)].filter(isPresent))
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
		const cardPath = resolve(repoRoot, workspace, "model-card.json")

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
async function resolveBaseLocale(repoRoot: string, locales: readonly string[]): Promise<string> {
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
	const cardPath = resolve(repoRoot, weightsWorkspace(baseLocale), "model-card.json")
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
async function distributionOnlyRemoteNames(repoRoot: string, baseLocale: string): Promise<string[]> {
	const cardPath = resolve(repoRoot, weightsWorkspace(baseLocale), "model-card.json")

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
	const resolveRoot = configured.replace(/\/+$/, "")
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)

	return `${resolveRoot}/${baseLocale}/v${version}`
}

/**
 * Every artifact a release's weights packages declare and a checkout does not carry.
 *
 * Derived from three machine-readable owners and nothing else: `release.config.json` names the locales, each package's
 * `files` array names its artifacts, and `git ls-files` says which are already here.
 */
export async function planWeightsMaterialization(repoRoot: string): Promise<WeightsArtifactPlan[]> {
	const config = await readReleaseConfig(repoRoot)
	const repoSources = repoCommittedSoftFeedSources(repoRoot, config.softFeed ?? {})
	const workspaces = config.locales.map((locale) => weightsWorkspace(locale))
	const tracked = trackedFiles(repoRoot, workspaces)
	const checksums = await declaredChecksums(repoRoot, workspaces)
	const plans: WeightsArtifactPlan[] = []

	for (const workspace of workspaces) {
		const manifest = await readWorkspaceManifest(repoRoot, workspace)

		for (const filename of literalFilesEntries(manifest.files)) {
			if (tracked.has(`${workspace}/${filename}`)) continue

			if (filename.includes("/")) {
				throw new Error(
					`fetch-hf-weights: ${workspace} declares the untracked nested entry "${filename}". The bucket stages ` +
						"artifacts flat by shipped name and this recipe has no rule for a nested one — add one here rather than " +
						"letting the tarball audit report it missing after 49 packages have published."
				)
			}

			const sourcePath = repoSources.get(filename)
			const expectedMD5 = checksums.get(filename)

			plans.push({
				workspace,
				filename,
				origin: sourcePath ? { kind: "repo", sourcePath } : { kind: "hf", remoteName: filename },
				...(expectedMD5 ? { expectedMD5 } : {}),
			})
		}
	}

	return plans
}

/**
 * HEAD-probe one bucket object. Returns the failure's message rather than a bare boolean: a throttled or unroutable
 * probe is indistinguishable from an unstaged artifact at the call site, and "MISSING" is the answer that would send an
 * operator to re-run a staging step that already succeeded.
 */
async function probeRemote(url: string): Promise<string | null> {
	try {
		await bucketClient.fetch({ url, method: "head" })

		return null
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

/**
 * Download one bucket object whole. Axios's node adapter answers `arraybuffer` with a `Buffer`; its fetch adapter
 * answers with an `ArrayBuffer`, so both shapes are accepted.
 */
async function downloadRemote(url: string): Promise<Buffer> {
	const response = await bucketClient.fetch<ArrayBuffer | Buffer>({ url, responseType: "arraybuffer" })
	const body = response.data

	return Buffer.isBuffer(body) ? body : Buffer.from(body)
}

/**
 * Write `bytes` to a workspace file.
 *
 * Unlink first. `writeFileSync` FOLLOWS a symlink at the destination and writes THROUGH it, leaving the symlink in
 * place — and the registry refuses a tarball containing one (HTTP 415, YN0035). A dev checkout's weights workspaces are
 * full of symlinks, and the staging tree can inherit one, so the discipline applies to both destinations. Same rule as
 * `copy-weights.ts`; see AGENTS.md "symlinks in the publish tarball".
 */
async function writeArtifact(destination: string, bytes: Buffer): Promise<void> {
	await makeDirectories(resolve(destination, ".."))
	await removePathIfPresent(destination)
	await writeLocalFile(bytes, destination)
}

/**
 * Verify `bytes` against a plan's declared md5, refusing with the artifact named on a mismatch.
 */
function verifyChecksum(plan: WeightsArtifactPlan, bytes: Buffer, source: string): void {
	if (!plan.expectedMD5) return

	const actual = md5Hex(bytes)

	if (actual !== plan.expectedMD5) {
		throw new Error(
			`fetch-hf-weights: ${plan.filename} does not match the md5 the model cards declare — expected ` +
				`${plan.expectedMD5}, got ${actual} (${source}). A staged object left over from an earlier release is ` +
				"present, non-empty and wrong; re-stage it with `mailwoman release hf` before publishing."
		)
	}
}

export interface FetchHFWeightsOptions {
	/**
	 * The checkout the recipe is READ from — manifests, model cards, committed lexicons. Never written to unless it is
	 * also the destination.
	 */
	repoRoot?: string
	/**
	 * The model-card version naming the bucket directory. Defaults to the base package's card, which is what CI read.
	 */
	version?: string
}

/**
 * Materialize every planned artifact under `destRoot`.
 *
 * Fetches each distinct bucket object ONCE and writes it to every workspace that declares it — the `cp` fan-out the
 * YAML spelled out by hand. HEAD-probes the whole remote set first so an unstaged version fails in one pass with every
 * missing object named, rather than after the first 39 MB download dies on a 404.
 */
export async function fetchHFWeights(
	destRoot: string,
	{ repoRoot = String(repoRootPath()), version }: FetchHFWeightsOptions = {}
): Promise<HFMaterializationReport> {
	const config = await readReleaseConfig(repoRoot)
	const baseLocale = await resolveBaseLocale(repoRoot, config.locales)
	const resolvedVersion = version ?? (await readBaseModelVersion(repoRoot))
	const base = await hfVersionBase(repoRoot, resolvedVersion)
	const plans = await planWeightsMaterialization(repoRoot)
	const remoteNames = new Set<string>()

	for (const plan of plans) {
		if (plan.origin.kind === "hf") {
			remoteNames.add(plan.origin.remoteName)
		}
	}

	const probeOnly = await distributionOnlyRemoteNames(repoRoot, baseLocale)

	process.stderr.write(`hf weights: v${resolvedVersion} → ${base}\n`)

	process.stderr.write(
		`hf weights: ${plans.length} declared artifacts, ${remoteNames.size} distinct bucket objects, ` +
			`${probeOnly.length} distribution-only (probed, never fetched)\n`
	)

	const probes = await Promise.all(
		[...remoteNames, ...probeOnly].map(async (remoteName) => {
			const failure = await probeRemote(`${base}/${remoteName}`)

			return { remoteName, failure }
		})
	)

	const unreachable = probes.filter((probe) => probe.failure)

	if (unreachable.length) {
		const lines = unreachable.map((probe) => `  ✗ ${base}/${probe.remoteName}: ${probe.failure}`)

		const probed = remoteNames.size + probeOnly.length

		throw new Error(
			`fetch-hf-weights: ${unreachable.length} of ${probed} artifacts are not readable for v${resolvedVersion}. ` +
				`Stage them from the operator's host with \`mailwoman release hf v${resolvedVersion} …\` (RELEASING.md §3), ` +
				"then re-run. Every object below is staged flat by its basename, through the flag family that carries it — " +
				"--model / --tokenizer, --postcodes, --pair-indexes, --fsts, --gazetteer-lexicon, --country-lexicon, " +
				"--street-type-lexicon, --locality-surface-lexicon, --fisher (`mailwoman release hf --help`):\n" +
				lines.join("\n")
		)
	}

	const report: HFMaterializationReport = {
		version: resolvedVersion,
		base,
		downloaded: 0,
		written: 0,
		bytes: 0,
		checksumVerified: 0,
		checksumUndeclared: [],
	}

	const undeclared = new Set<string>()

	for (const remoteName of remoteNames) {
		const url = `${base}/${remoteName}`
		const bytes = await downloadRemote(url)

		report.downloaded += 1
		report.bytes += bytes.byteLength

		for (const plan of plans) {
			if (plan.origin.kind !== "hf" || plan.origin.remoteName !== remoteName) continue

			verifyChecksum(plan, bytes, url)

			if (plan.expectedMD5) {
				report.checksumVerified += 1
			} else {
				undeclared.add(plan.filename)
			}

			await writeArtifact(resolve(destRoot, plan.workspace, plan.filename), bytes)
			report.written += 1
		}

		process.stderr.write(`  ✓ ${remoteName} (${bytes.byteLength.toLocaleString("en-US")} bytes)\n`)
	}

	for (const plan of plans) {
		if (plan.origin.kind !== "repo") continue

		if (!(await pathExists(plan.origin.sourcePath))) {
			throw new Error(
				`fetch-hf-weights: ${plan.workspace} declares ${plan.filename}, which release.config.json sources from the ` +
					`checkout at ${plan.origin.sourcePath} — and it is not there.`
			)
		}

		const bytes = await readLocalBuffer(plan.origin.sourcePath)

		verifyChecksum(plan, bytes, plan.origin.sourcePath)

		if (plan.expectedMD5) {
			report.checksumVerified += 1
		} else {
			undeclared.add(plan.filename)
		}

		await writeArtifact(resolve(destRoot, plan.workspace, plan.filename), bytes)
		report.written += 1
		report.bytes += bytes.byteLength
	}

	report.checksumUndeclared = [...undeclared].toSorted()

	return report
}

/**
 * Print a materialization receipt to stderr.
 */
export function reportHFMaterialization(report: HFMaterializationReport): void {
	const megabytes = (report.bytes / 1_000_000).toFixed(1)

	process.stderr.write(
		`hf weights: wrote ${report.written} artifacts (${report.downloaded} downloads, ${megabytes} MB), ` +
			`${report.checksumVerified} md5-verified\n`
	)

	if (report.checksumUndeclared.length) {
		process.stderr.write(
			`hf weights: no model card declares an md5 for ${report.checksumUndeclared.join(", ")} — those bytes are ` +
				"staged, not verified\n"
		)
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			into: { type: "string" },
			version: { type: "string" },
		},
	})

	const repoRoot = String(repoRootPath())
	const destRoot = values.into ? resolve(repoRoot, values.into) : repoRoot
	const report = await fetchHFWeights(destRoot, { repoRoot, ...(values.version ? { version: values.version } : {}) })

	reportHFMaterialization(report)
}

runIfScript(import.meta, main)
