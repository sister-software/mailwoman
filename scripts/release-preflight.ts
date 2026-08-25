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
 *   `--source repo` (the default, and the only mode this phase implements) materializes weights from
 *   the machine's data root via the SAME `copyWeights` recipe the release path runs — pointed at the
 *   staging tree instead of the checkout. `--source hf` (the CI recipe as typed code) is the next
 *   phase of #1894; until it lands, the flag names its own absence rather than half-running.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"
import { repoRootPath } from "@mailwoman/core/utils"

import { copyWeights } from "./copy-weights.ts"
import {
	auditStagedWorkspaces,
	checkReleaseListIdentity,
	releaseWorkspaces,
	stageReleaseTree,
} from "./release-stage.ts"

async function releasePreflight(): Promise<void> {
	const { values } = parseArgs({
		options: {
			source: { type: "string", default: "repo" },
			staging: { type: "string" },
			keep: { type: "boolean", default: false },
		},
	})

	if (values.source !== "repo") {
		throw new Error(
			`--source ${JSON.stringify(values.source)} is not implemented yet — this phase of #1894 ships repo mode; ` +
				"the hf mode (the CI fetch recipe as typed code) is the next phase."
		)
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

	// 2. Stage + materialize + audit.
	process.stderr.write(`staging tracked tree → ${stagingRoot}\n`)
	stageReleaseTree(repoRoot, stagingRoot)
	await copyWeights(stagingRoot)

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
		`${verdict ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} workspaces packed and ` +
			`audited${identityProblems.length ? `, ${identityProblems.length} release-list problem(s)` : ""} in ${elapsed}s\n`
	)

	if (!verdict) {
		process.exitCode = 1
	}
}

runIfScript(import.meta, releasePreflight)
