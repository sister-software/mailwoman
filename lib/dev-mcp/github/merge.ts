// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_pull_request`'s completion record and its squash merge.
 *
 * `complete` records, per pull request, the head commit whose checks it verified.
 * `merge` reads that record and refuses unless every condition holds for the current head:
 * the pull request is open, `complete` succeeded for that head, zero checks are pending
 * or failed, and GitHub's merge state is `CLEAN`.
 *
 * The merge passes `--match-head-commit`, so GitHub refuses it when the head moves
 * after the checks were read.
 *
 * The record lives in the server checkout's `.claude/state/`, which every
 * worktree's call reaches through the same server.
 */

import { tryReadLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { resolvePath } from "path-ts"

import {
	ChecksCondition,
	PULL_REQUEST_REPO,
	type PullRequestChecksReading,
	readPullRequestChecks,
} from "#check-kit/pull-request/checks"
import type { RunGitHub } from "#dev-mcp/github"

/**
 * One successful `complete`: the head commit it verified.
 */
export interface PullRequestCompletion {
	pullRequestNumber: number
	issueNumber: number
	head: string
	completedAt: string
}

type CompletionRecords = Record<string, PullRequestCompletion>

/**
 * The completion record file in the server checkout.
 */
function completionRecordPath(repoRoot: string): string {
	return resolvePath(repoRoot, ".claude", "state", "completed-pull-requests.json")
}

/**
 * Record that `complete` verified `head` for a pull request, replacing an earlier record for it.
 */
export async function recordPullRequestCompletion(
	repoRoot: string,
	completion: Omit<PullRequestCompletion, "completedAt">,
	now: Date = new Date()
): Promise<PullRequestCompletion> {
	const path = completionRecordPath(repoRoot)
	const records = (await tryReadLocalJSONFile<CompletionRecords>(path)) ?? {}
	const entry = { ...completion, completedAt: now.toISOString() }

	await writeLocalJSONFile({ ...records, [String(completion.pullRequestNumber)]: entry }, path)

	return entry
}

/**
 * The completion recorded for a pull request, or `null` when `complete` never succeeded for it.
 */
async function readPullRequestCompletion(
	repoRoot: string,
	pullRequestNumber: number
): Promise<PullRequestCompletion | null> {
	const records = await tryReadLocalJSONFile<CompletionRecords>(completionRecordPath(repoRoot))

	return records?.[String(pullRequestNumber)] ?? null
}

/**
 * Each merge condition that fails for this reading and completion record, as one sentence.
 */
function mergeRefusals(reading: PullRequestChecksReading, completion: PullRequestCompletion | null): string[] {
	const refusals: string[] = []
	const n = reading.number

	if (reading.state !== "OPEN") {
		refusals.push(`#${n} is ${reading.state.toLowerCase()}, and only an open pull request is merged.`)
	}

	if (!completion) {
		refusals.push(`\`complete\` has not succeeded for #${n}, so no head commit is recorded as reviewed.`)
	} else if (completion.head !== reading.headCommit) {
		refusals.push(
			`\`complete\` succeeded for head ${completion.head}, and the current head is ${reading.headCommit}; run \`complete\` again for the current head.`
		)
	}

	if (reading.condition === ChecksCondition.Unread) {
		refusals.push(`the checks on ${reading.headCommit} are unread: ${reading.checksError}.`)
	} else if (reading.condition === ChecksCondition.NoChecks) {
		refusals.push(`the head ${reading.headCommit} has zero checks: ${reading.noChecksReason}.`)
	} else if (reading.condition !== ChecksCondition.Passed && reading.counts) {
		const { pending, fail, cancel } = reading.counts

		refusals.push(
			`the checks on ${reading.headCommit} have ${pending} pending, ${fail} failed and ${cancel} cancelled, and a merge needs zero of each.`
		)
	}

	if (reading.mergeState !== "CLEAN") {
		refusals.push(
			`GitHub's merge state is ${reading.mergeState} (mergeable ${reading.mergeable}), and a merge needs CLEAN.`
		)
	}

	return refusals
}

/**
 * What a merge returned: the merge commit and the state of each issue the pull request closes.
 */
export interface PullRequestMerge {
	pullRequestNumber: number
	head: string
	state: string
	mergeCommit: string | null
	linkedIssues: Array<{ number: number; state: string }>
}

interface RawMergedView {
	state: string
	mergeCommit: { oid: string } | null
	closingIssuesReferences: Array<{ number: number }>
}

/**
 * Squash-merge a pull request after every condition {@link mergeRefusals} checks holds.
 *
 * The branch is kept.
 *
 * @throws An error that lists every failed condition, before `gh pr merge` runs.
 */
export async function mergePullRequest(
	pullRequestNumber: number,
	options: { repoRoot: string; run: RunGitHub; cwd?: string }
): Promise<PullRequestMerge> {
	const { run, repoRoot, cwd } = options
	const reading = await readPullRequestChecks(pullRequestNumber, run)
	const completion = await readPullRequestCompletion(repoRoot, pullRequestNumber)
	const refusals = mergeRefusals(reading, completion)

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
		linkedIssues,
	}
}
