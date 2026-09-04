/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwops release preflight` — the #1894 dispatch-free release exercise: stage the tracked tree in an
 *   isolated root, materialize the weights artifacts there, then pack and audit ALL release
 *   workspaces with the same `packWorkspaceForPublish` + `verifyTarball` path CI publishes with.
 *   Performs zero git, GitHub, npm-registry, R2, or Hugging Face writes; an interrupted run leaves
 *   every tracked file byte-identical because nothing ever writes into the checkout (see
 *   `stage.ts` for why staging, not try/finally, is the mechanism).
 *
 *   Two sources, one audit. `--source repo` (the default) materializes weights from the machine's data
 *   root via the SAME `copyWeights` recipe the release path runs; `--source hf` reads the public
 *   Hugging Face bucket via the SAME `fetchHFWeights` recipe the publish workflow runs. Both are
 *   pointed at the staging tree instead of the checkout, and both hand the identical tree to the
 *   identical audit — that sharing is the point. `--source hf` needs no credentials and reads the
 *   version from the base package's model card unless `--version` names another.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"

import { formatTarballAudit } from "#pack/verify-tarball"
import { auditStagedWorkspaces, checkReleaseListIdentity, releaseWorkspaces, stageReleaseTree } from "#release/stage"
import { copyWeights } from "#weights/copy-weights"
import { fetchHFWeights, reportHFMaterialization } from "#weights/fetch-hf-weights"

/**
 * Where the staged weights artifacts come from. `repo` reads this machine's data root, `hf` reads the public bucket CI
 * publishes from.
 */
export const WEIGHTS_SOURCES = ["repo", "hf"] as const

export type WeightsSource = (typeof WEIGHTS_SOURCES)[number]

export interface ReleasePreflightOptions {
	repoRoot: string
	source: WeightsSource
	/**
	 * The Hugging Face bucket directory to read, `--source hf` only.
	 */
	version?: string
	/**
	 * The CALLER'S staging directory: written into and never removed. Absent, a scratch directory is made and owned here.
	 */
	staging?: string
	/**
	 * Withhold removal of the scratch staging directory so the staged tree survives for inspection.
	 */
	keep: boolean
	log: (line: string) => void
}

export interface ReleasePreflightReport {
	source: WeightsSource
	stagingRoot: string
	publishCount: number
	releaseListProblems: string[]
	audited: number
	failed: string[]
	elapsedSeconds: number
	verdict: "PASS" | "FAIL"
}

/**
 * Stage, materialize, pack and audit every release workspace. Answers the report; the verdict is FAIL when any release
 * workspace does not pack to a tarball honoring its manifest, or when the release list's named-absence identity does
 * not hold.
 */
export async function releasePreflight(options: ReleasePreflightOptions): Promise<ReleasePreflightReport> {
	const { repoRoot, source, log } = options

	if (source === "repo" && options.version) {
		throw new Error("--version names a Hugging Face bucket directory and applies to --source hf only.")
	}

	const startedAt = performance.now()
	await using resources = new AsyncDisposableStack()

	// Two ownership rules, and they are separate. A `--staging` root is the CALLER'S directory: this operation writes
	// into it and never removes it. The one it makes itself is its own, and `--keep` withholds removal so the staged
	// tree survives for inspection — registering it is what decides that, rather than a branch at the far end.
	let stagingRoot = options.staging

	if (!stagingRoot) {
		const scratch = await temporaryDirectory("mailwoman-release-preflight-")

		if (!options.keep) {
			resources.use(scratch)
		}

		stagingRoot = String(scratch.path)
	}

	// 1. The named-absence identity — every workspace outside the release list must be sanctioned by name.
	const identity = await checkReleaseListIdentity(repoRoot)

	const releaseListProblems = [
		...identity.unexpectedAbsences.map(
			(workspace) =>
				`${workspace} is in neither the release list nor the sanctioned-absence record — it is silently frozen ` +
				"at its last published version until someone answers for it (release/stage.ts owns the record)."
		),
		...identity.staleSanctions.map(
			(workspace) => `${workspace} is sanctioned as absent but no longer exists in the root workspaces array.`
		),
		...identity.danglingReleaseEntries.map(
			(workspace) => `${workspace} is in the release list but not in the root workspaces array.`
		),
	]

	for (const problem of releaseListProblems) {
		log(`✗ ${problem}`)
	}

	log(`release list: ${identity.publishCount} workspaces`)

	// 2. Stage + materialize + audit. Both sources write into the staging tree ONLY, so the two legs differ
	// in where the bytes come from and in nothing the audit can see.
	log(`staging tracked tree → ${stagingRoot}`)
	await stageReleaseTree(repoRoot, stagingRoot)

	if (source === "repo") {
		await copyWeights({ repoRoot, destRoot: stagingRoot, log })
	} else {
		const materialization = await fetchHFWeights(stagingRoot, {
			repoRoot,
			...(options.version ? { version: options.version } : {}),
			log,
		})

		reportHFMaterialization(materialization, log)
	}

	const results = await auditStagedWorkspaces(stagingRoot, await releaseWorkspaces(repoRoot))
	const failed = results.filter((result) => !result.ok)

	for (const result of results) {
		if (result.ok) {
			const counts = result.counts!

			log(`✓ ${result.workspace}  (${formatTarballAudit(counts)})`)
		} else {
			log(`✗ ${result.workspace}`)

			for (const failure of result.failures) {
				log(failure.replaceAll(/^/gm, "    "))
			}
		}
	}

	const elapsedSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(1))
	const verdict = !releaseListProblems.length && !failed.length ? "PASS" : "FAIL"

	log(
		`${verdict} (--source ${source}): ${results.length - failed.length}/${results.length} workspaces ` +
			`packed and audited${releaseListProblems.length ? `, ${releaseListProblems.length} release-list problem(s)` : ""} in ` +
			`${elapsedSeconds}s`
	)

	return {
		source,
		stagingRoot,
		publishCount: identity.publishCount,
		releaseListProblems,
		audited: results.length,
		failed: failed.map((result) => result.workspace),
		elapsedSeconds,
		verdict,
	}
}
