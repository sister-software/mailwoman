// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads one pull request's checks through `gh`: the head commit, the base branch,
 * the mergeable and merge-state values, and each check with its bucket.
 *
 * `gh pr checks` exits 8 while a check is pending and 1 when one failed,
 * and prints the JSON either way, so the JSON of a failed call is read.
 * The checks are reported unread only when no JSON came back.
 *
 * A pull request whose merge state is conflicting gets no `pull_request` workflow run,
 * so its zero checks are reported as their own condition with that reason rather than as passed.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { isProcessError } from "@mailwoman/core/process"

import { type RunGitHub, runGitHub } from "#dev-mcp/github"

/**
 * The repository every pull request operation reads.
 */
export const PULL_REQUEST_REPO = "sister-software/mailwoman"

/**
 * The buckets `gh pr checks` sorts a check into.
 */
export const CheckBucket = {
	Pass: "pass",
	Fail: "fail",
	Pending: "pending",
	Skipping: "skipping",
	Cancel: "cancel",
} as const

export type CheckBucket = (typeof CheckBucket)[keyof typeof CheckBucket]

/**
 * One check on the pull request's head commit.
 */
export interface PullRequestCheck {
	workflow: string
	name: string
	/**
	 * GitHub's state, such as `SUCCESS`, `FAILURE`, `IN_PROGRESS` or `SKIPPED`.
	 */
	state: string
	bucket: CheckBucket
	link: string
	/**
	 * The Actions run and job the link names, or `null` for a check that isn't an Actions job.
	 */
	runID: number | null
	jobID: number | null
	/**
	 * The id at the end of a link of the form `…/runs/<id>`, for a check that
	 * isn't an Actions job, such as CodeQL.
	 *
	 * It is `null` for an Actions job.
	 * An Actions job's id is its check run id.
	 */
	checkRunID: number | null
	startedAt: string | null
	completedAt: string | null
}

/**
 * The overall condition of a pull request's checks.
 *
 * - `passed`: every check concluded, and none failed or was cancelled.
 * - `failed`: at least one check failed or was cancelled, whether or not others are still running.
 * - `pending`: at least one check hasn't concluded, and none has failed or been cancelled.
 * - `no-checks`: GitHub reports zero checks on the head; `noChecksReason` states why.
 * - `unread`: `gh` returned no checks JSON; `checksError` states what it printed.
 */
export const ChecksCondition = {
	Passed: "passed",
	Failed: "failed",
	Pending: "pending",
	NoChecks: "no-checks",
	Unread: "unread",
} as const

export type ChecksCondition = (typeof ChecksCondition)[keyof typeof ChecksCondition]

/**
 * One reading of a pull request and its checks.
 */
export interface PullRequestChecksReading {
	number: number
	title: string
	url: string
	state: "OPEN" | "CLOSED" | "MERGED"
	headCommit: string
	headBranch: string
	baseBranch: string
	/**
	 * GitHub's `mergeable` value: `MERGEABLE`, `CONFLICTING` or `UNKNOWN`.
	 */
	mergeable: string
	/**
	 * GitHub's `mergeStateStatus` value, such as `CLEAN`, `DIRTY`, `BLOCKED`, `BEHIND` or `UNKNOWN`.
	 */
	mergeState: string
	/**
	 * Whether GitHub reports a merge conflict with the base branch.
	 */
	conflicting: boolean
	condition: ChecksCondition
	/**
	 * The checks, or `null` when they're unread.
	 */
	checks: PullRequestCheck[] | null
	checksError: string | null
	noChecksReason: string | null
	/**
	 * The number of checks in each bucket, or `null` when the checks are unread.
	 */
	counts: Record<CheckBucket, number> | null
}

interface RawPullRequestView {
	number: number
	title: string
	url: string
	state: "OPEN" | "CLOSED" | "MERGED"
	headRefOid: string
	headRefName: string
	baseRefName: string
	mergeable: string
	mergeStateStatus: string
}

interface RawCheck {
	bucket: CheckBucket
	completedAt: string
	link: string
	name: string
	startedAt: string
	state: string
	workflow: string
}

const VIEW_FIELDS = "number,title,url,state,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus"

const CHECK_FIELDS = "bucket,completedAt,link,name,startedAt,state,workflow"

/**
 * What `gh pr checks` prints, on stderr, for a head with zero checks.
 */
const NO_CHECKS_MESSAGE = /no checks reported/iu

/**
 * The run and job ids in an Actions job link.
 */
const JOB_LINK = /\/actions\/runs\/(\d+)\/job\/(\d+)/u

/**
 * The check run id in the link of a check that isn't an Actions job,
 * such as `https://github.com/<owner>/<repo>/runs/<id>`.
 */
const CHECK_RUN_LINK = /^https:\/\/github\.com\/[^/]+\/[^/]+\/runs\/(\d+)$/u

/**
 * The most reads the reader makes when the head moved between the view and the checks.
 */
const HEAD_READ_ATTEMPTS = 3

/**
 * A timestamp GitHub writes for a check that hasn't started or finished.
 */
const UNSET_TIME = "0001-01-01T00:00:00Z"

function timeOrNull(value: string | undefined): string | null {
	return value && value !== UNSET_TIME ? value : null
}

function toCheck(raw: RawCheck): PullRequestCheck {
	const ids = JOB_LINK.exec(raw.link ?? "")
	const checkRun = ids ? null : CHECK_RUN_LINK.exec(raw.link ?? "")

	return {
		workflow: raw.workflow,
		name: raw.name,
		state: raw.state,
		bucket: raw.bucket,
		link: raw.link,
		runID: ids ? Number(ids[1]) : null,
		jobID: ids ? Number(ids[2]) : null,
		checkRunID: checkRun ? Number(checkRun[1]) : null,
		startedAt: timeOrNull(raw.startedAt),
		completedAt: timeOrNull(raw.completedAt),
	}
}

/**
 * The checks JSON `gh pr checks` printed, `"none"` for a head with zero checks,
 * or the error when it printed neither.
 */
type RawChecksReading = { checks: RawCheck[] } | { none: true } | { error: string }

async function readRawChecks(pullRequestNumber: number, run: RunGitHub): Promise<RawChecksReading> {
	let stdout: string

	try {
		stdout = await run(["pr", "checks", String(pullRequestNumber), "--repo", PULL_REQUEST_REPO, "--json", CHECK_FIELDS])
	} catch (error) {
		if (!isProcessError(error)) return { error: error instanceof Error ? error.message : String(error) }

		if (!error.stdout.trim()) {
			if (NO_CHECKS_MESSAGE.test(error.stderr) || NO_CHECKS_MESSAGE.test(error.message)) return { none: true }

			return { error: error.stderr.trim() || error.message }
		}

		stdout = error.stdout
	}

	try {
		const checks = parseJSONStrict<RawCheck[]>(stdout)

		if (!Array.isArray(checks)) return { error: "gh pr checks printed JSON that is not an array" }

		return { checks }
	} catch (error) {
		return { error: `gh pr checks printed output that is not JSON: ${error instanceof Error ? error.message : error}` }
	}
}

async function readView(pullRequestNumber: number, run: RunGitHub): Promise<RawPullRequestView> {
	return parseJSONStrict<RawPullRequestView>(
		await run(["pr", "view", String(pullRequestNumber), "--repo", PULL_REQUEST_REPO, "--json", VIEW_FIELDS])
	)
}

function countBuckets(checks: readonly PullRequestCheck[]): Record<CheckBucket, number> {
	const counts: Record<CheckBucket, number> = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 }

	for (const check of checks) {
		counts[check.bucket] = (counts[check.bucket] ?? 0) + 1
	}

	return counts
}

/**
 * The condition a set of read checks produces.
 *
 * A failed or cancelled check decides the condition before a pending one does.
 *
 * The pull request cannot pass once one check has failed.
 * A `pending` condition held until the last check concludes would hide that failure.
 */
function conditionOf(counts: Record<CheckBucket, number>, total: number): ChecksCondition {
	if (!total) return ChecksCondition.NoChecks

	if (counts.fail || counts.cancel) return ChecksCondition.Failed

	return counts.pending ? ChecksCondition.Pending : ChecksCondition.Passed
}

function noChecksReason(view: RawPullRequestView, conflicting: boolean): string {
	if (conflicting) {
		return (
			`the pull request conflicts with ${view.baseRefName} (mergeable ${view.mergeable}, merge state ${view.mergeStateStatus}), ` +
			"so GitHub starts no pull_request workflow run until the conflict is resolved"
		)
	}

	return `GitHub reports no check on head ${view.headRefOid} yet`
}

/**
 * Read one pull request and its checks.
 *
 * The view is read before and after the checks.
 * When the head moved in between, the read starts again, at most {@link HEAD_READ_ATTEMPTS}
 * times, so the checks always belong to the reported head.
 *
 * @param run The `gh` runner, injected by a test.
 * @throws When `gh pr view` fails, because the pull request itself is then unread.
 */
export async function readPullRequestChecks(
	pullRequestNumber: number,
	run: RunGitHub = runGitHub
): Promise<PullRequestChecksReading> {
	for (let attempt = 1; ; attempt++) {
		const before = await readView(pullRequestNumber, run)
		const raw = await readRawChecks(pullRequestNumber, run)
		const view = await readView(pullRequestNumber, run)

		if (before.headRefOid !== view.headRefOid && attempt < HEAD_READ_ATTEMPTS) continue

		const conflicting = view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY"

		const base = {
			number: view.number,
			title: view.title,
			url: view.url,
			state: view.state,
			headCommit: view.headRefOid,
			headBranch: view.headRefName,
			baseBranch: view.baseRefName,
			mergeable: view.mergeable,
			mergeState: view.mergeStateStatus,
			conflicting,
		}

		if (before.headRefOid !== view.headRefOid) {
			return {
				...base,
				condition: ChecksCondition.Unread,
				checks: null,
				checksError: `the head moved on each of ${HEAD_READ_ATTEMPTS} reads, last from ${before.headRefOid} to ${view.headRefOid}`,
				noChecksReason: null,
				counts: null,
			}
		}

		if ("error" in raw) {
			return {
				...base,
				condition: ChecksCondition.Unread,
				checks: null,
				checksError: raw.error,
				noChecksReason: null,
				counts: null,
			}
		}

		const checks = "checks" in raw ? raw.checks.map(toCheck) : []
		const counts = countBuckets(checks)
		const condition = conditionOf(counts, checks.length)

		return {
			...base,
			condition,
			checks,
			checksError: null,
			noChecksReason: condition === ChecksCondition.NoChecks ? noChecksReason(view, conflicting) : null,
			counts,
		}
	}
}

/**
 * Whether a check didn't pass: it failed, was cancelled or is still pending.
 */
export function checkDidNotPass(check: PullRequestCheck): boolean {
	return check.bucket !== CheckBucket.Pass && check.bucket !== CheckBucket.Skipping
}
