// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_pull_request`'s squash merge.
 *
 * A merge needs an open pull request whose branch merges without conflicts.
 * It doesn't wait for CI: the caller runs the checks locally first, and the result
 * reports the CI state the merge started under so the caller can state it.
 *
 * The merge passes `--match-head-commit`, so GitHub refuses it when the head moves after it was read.
 */

import { parseJSONStrict } from "@mailwoman/core/values/json"

import {
	ChecksCondition,
	PULL_REQUEST_REPO,
	type PullRequestChecksReading,
	readPullRequestChecks,
} from "#check-kit/pull-request/checks"
import type { RunGitHub } from "#dev-mcp/github"

/**
 * Each merge condition that fails for this reading, as one sentence.
 */
function mergeRefusals(reading: PullRequestChecksReading): string[] {
	const refusals: string[] = []
	const n = reading.number

	if (reading.state !== "OPEN") {
		refusals.push(`#${n} is ${reading.state.toLowerCase()}, and only an open pull request is merged.`)
	}

	if (reading.conflicting) {
		refusals.push(`#${n} conflicts with its base; rebase or merge the base into the branch first.`)
	}

	return refusals
}

/**
 * One sentence stating the CI state on the merged head.
 */
function describeChecks(reading: PullRequestChecksReading): string {
	if (reading.condition === ChecksCondition.Unread) return `unread: ${reading.checksError}`

	if (reading.condition === ChecksCondition.NoChecks) return `zero checks: ${reading.noChecksReason}`

	if (!reading.counts) return reading.condition

	const { pending, fail, cancel } = reading.counts

	return `${pending} pending, ${fail} failed and ${cancel} cancelled`
}

/**
 * What a merge returned: the merge commit, the CI state it merged under,
 * and the state of each issue the pull request closes.
 */
export interface PullRequestMerge {
	pullRequestNumber: number
	head: string
	state: string
	mergeCommit: string | null
	checksAtMerge: string
	linkedIssues: Array<{ number: number; state: string }>
}

interface RawMergedView {
	state: string
	mergeCommit: { oid: string } | null
	closingIssuesReferences: Array<{ number: number }>
}

/**
 * Squash-merge an open, conflict-free pull request at the head it read.
 * The branch is kept.
 *
 * @throws An error that lists every failed condition, before `gh pr merge` runs.
 */
export async function mergePullRequest(
	pullRequestNumber: number,
	options: { run: RunGitHub; cwd?: string }
): Promise<PullRequestMerge> {
	const { run, cwd } = options
	const reading = await readPullRequestChecks(pullRequestNumber, run)
	const refusals = mergeRefusals(reading)

	if (refusals.length) {
		throw new Error(`Merge of #${pullRequestNumber} refused:\n${refusals.map((line) => `- ${line}`).join("\n")}`)
	}

	await run(
		[
			"pr",
			"merge",
			String(pullRequestNumber),
			"--repo",
			PULL_REQUEST_REPO,
			"--squash",
			"--match-head-commit",
			reading.headCommit,
		],
		{ cwd }
	)

	const merged = parseJSONStrict<RawMergedView>(
		await run([
			"pr",
			"view",
			String(pullRequestNumber),
			"--repo",
			PULL_REQUEST_REPO,
			"--json",
			"state,mergeCommit,closingIssuesReferences",
		])
	)

	const linkedIssues: PullRequestMerge["linkedIssues"] = []

	for (const issue of merged.closingIssuesReferences ?? []) {
		const { state } = parseJSONStrict<{ state: string }>(
			await run(["issue", "view", String(issue.number), "--repo", PULL_REQUEST_REPO, "--json", "state"])
		)

		linkedIssues.push({ number: issue.number, state })
	}

	return {
		pullRequestNumber,
		head: reading.headCommit,
		state: merged.state,
		mergeCommit: merged.mergeCommit?.oid ?? null,
		checksAtMerge: describeChecks(reading),
		linkedIssues,
	}
}
