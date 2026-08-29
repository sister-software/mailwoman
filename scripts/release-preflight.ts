#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `yarn release:preflight` — the #1894 dispatch-free release exercise: stage the tracked tree in an
 *   isolated root, materialize the weights artifacts there, then pack and audit ALL release
 *   workspaces with the same `packWorkspaceForPublish` + `verifyTarball` path CI publishes with.
 *   Performs zero git, GitHub, npm-registry, R2, or Hugging Face writes; an interrupted run leaves
 *   every tracked file byte-identical because nothing ever writes into the checkout (see
 *   `release-stage.ts` for why staging, not try/finally, is the mechanism).
 *
 *   Two sources, one audit. `--source repo` (the default) materializes weights from the machine's data
 *   root via the SAME `copyWeights` recipe the release path runs; `--source hf` reads the public
 *   Hugging Face bucket via the SAME `fetchHFWeights` recipe the publish workflow runs. Both are
 *   pointed at the staging tree instead of the checkout, and both hand the identical tree to the
 *   identical audit — that sharing is the point. `--source hf` needs no credentials and reads the
 *   version from the base package's model card unless `--version` names another.
 */

import { runIfScript } from "@mailwoman/core/scripting"
import { repoRootPath } from "@mailwoman/core/utils"
import { mkdtempSync, rmSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"

import { copyWeights } from "./copy-weights.ts"
import { fetchHFWeights, reportHFMaterialization } from "./fetch-hf-weights.ts"
import {
	auditStagedWorkspaces,
	checkReleaseListIdentity,
	releaseWorkspaces,
	stageReleaseTree,
} from "./release-stage.ts"

/**
 * Where the staged weights artifacts come from. `repo` reads this machine's data root, `hf` reads the public bucket CI
 * publishes from.
 */
const WEIGHTS_SOURCES = ["repo", "hf"] as const

type WeightsSource = (typeof WEIGHTS_SOURCES)[number]

function assertWeightsSource(source: string): asserts source is WeightsSource {
	if (!(WEIGHTS_SOURCES as readonly string[]).includes(source)) {
		throw new Error(
			`--source ${JSON.stringify(source)} is not a weights source — expected one of: ${WEIGHTS_SOURCES.join(", ")}.`
		)
	}
}

async function releasePreflight(): Promise<void> {
	const { values } = parseArgs({
		options: {
			source: { type: "string", default: "repo" },
			version: { type: "string" },
			staging: { type: "string" },
			keep: { type: "boolean", default: false },
		},
	})

	const source = values.source ?? "repo"

	assertWeightsSource(source)

	if (source === "repo" && values.version) {
		throw new Error("--version names a Hugging Face bucket directory and applies to --source hf only.")
	}

	const startedAt = performance.now()
	const repoRoot = String(repoRootPath())
	const stagingRoot = values.staging ?? mkdtempSync(join(tmpdir(), "mailwoman-release-preflight-"))

	// 1. The named-absence identity — every workspace outside the release list must be sanctioned by name.
	const identity = checkReleaseListIdentity(repoRoot)

	const identityProblems = [
		...identity.unexpectedAbsences.map(
			(workspace) =>
				`${workspace} is in neither the release list nor the sanctioned-absence record — it is silently frozen ` +
				"at its last published version until someone answers for it (release-stage.ts owns the record)."
		),
		...identity.staleSanctions.map(
			(workspace) => `${workspace} is sanctioned as absent but no longer exists in the root workspaces array.`
		),
		...identity.danglingReleaseEntries.map(
			(workspace) => `${workspace} is in the release list but not in the root workspaces array.`
		),
	]

	for (const problem of identityProblems) {
		process.stderr.write(`✗ ${problem}\n`)
	}

	process.stderr.write(`release list: ${identity.publishCount} workspaces\n`)

	// 2. Stage + materialize + audit. Both sources write into the staging tree ONLY, so the two legs differ
	// in where the bytes come from and in nothing the audit can see.
	process.stderr.write(`staging tracked tree → ${stagingRoot}\n`)
	await stageReleaseTree(repoRoot, stagingRoot)

	if (source === "repo") {
		await copyWeights(stagingRoot)
	} else {
		const materialization = await fetchHFWeights(stagingRoot, {
			repoRoot,
			...(values.version ? { version: values.version } : {}),
		})

		reportHFMaterialization(materialization)
	}

	const results = auditStagedWorkspaces(stagingRoot, releaseWorkspaces(repoRoot))
	const failed = results.filter((result) => !result.ok)

	for (const result of results) {
		if (result.ok) {
			const counts = result.counts!

			process.stderr.write(
				`✓ ${result.workspace}  (${counts.literalFiles} files, ${counts.exportTargets} export targets, ` +
					`${counts.binTargets} bin targets)\n`
			)
		} else {
			process.stderr.write(`✗ ${result.workspace}\n`)

			for (const failure of result.failures) {
				process.stderr.write(`${failure.replaceAll(/^/gm, "    ")}\n`)
			}
		}
	}

	if (!values.keep && !values.staging) {
		rmSync(stagingRoot, { recursive: true, force: true })
	}

	const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1)
	const verdict = identityProblems.length === 0 && failed.length === 0

	process.stderr.write(
		`${verdict ? "PASS" : "FAIL"} (--source ${source}): ${results.length - failed.length}/${results.length} workspaces ` +
			`packed and audited${identityProblems.length ? `, ${identityProblems.length} release-list problem(s)` : ""} in ` +
			`${elapsed}s\n`
	)

	if (!verdict) {
		process.exitCode = 1
	}
}

runIfScript(import.meta, releasePreflight)
