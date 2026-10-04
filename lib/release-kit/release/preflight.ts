/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwops release preflight` stages the tracked tree in an isolated root, materializes the weights artifacts there, then packs and audits all release workspaces with the same `packWorkspaceForPublish` + `verifyTarball` path CI publishes with, performing no git, GitHub, npm-registry, R2, or Hugging Face writes.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"

import { formatTarballAudit } from "#release-kit/pack/verify-tarball"
import {
	auditStagedWorkspaces,
	checkReleaseListIdentity,
	releaseWorkspaces,
	stageReleaseTree,
} from "#release-kit/release/stage"
import { copyWeights } from "#release-kit/weights/copy-weights"
import { fetchHFWeights, reportHFMaterialization } from "#release-kit/weights/fetch-hf-weights"

/**
 * Where the staged weights artifacts come from: `repo` reads this machine's data root,
 * `hf` reads the public bucket CI publishes from.
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
	 * The caller's staging directory, written into and never removed.
	 * Absent, a scratch directory is made and owned here.
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
 * Stage, materialize, pack and audit every release workspace, returning a report whose
 * verdict is `FAIL` when any workspace does not pack to a tarball honoring its manifest
 * or when the release list and its computed absence set do not match.
 */
export async function releasePreflight(options: ReleasePreflightOptions): Promise<ReleasePreflightReport> {
	const { repoRoot, source, log } = options

	if (source === "repo" && options.version) {
		throw new Error("--version names a Hugging Face bucket directory and applies to --source hf only.")
	}

	const startedAt = performance.now()
	await using resources = new AsyncDisposableStack()

	// The caller's `--staging` root is written into and never removed.
	// A scratch root this operation makes belongs to this operation.
	// `--keep` withholds its removal so the staged tree survives for inspection.
	let stagingRoot = options.staging

	if (!stagingRoot) {
		const scratch = await temporaryDirectory("mailwoman-release-preflight-")

		if (!options.keep) {
			resources.use(scratch)
		}

		stagingRoot = scratch.path.toString()
	}

	// Every workspace outside the release list must be sanctioned by name.
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

	// Both sources write into the staging tree only, so the two legs differ in
	// where the bytes come from and in no other way the audit can see.
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
