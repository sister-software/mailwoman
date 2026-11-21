// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A pull request's check status, read once or waited on until a check fails or every
 * check concludes, with the failing tests of each failed job read from its log.
 *
 * `mwops pr status`, `mwops pr wait` and `mwdev_pull_request`'s `status` action return this result.
 */

import { type ClockLike, systemClock } from "@mailwoman/core/api/clock"

import { describeAnnotation, type ReadCheckAnnotations } from "#check-kit/pull-request/annotations"
import {
	checkDidNotPass,
	ChecksCondition,
	type PullRequestChecksReading,
	readPullRequestChecks,
} from "#check-kit/pull-request/checks"
import { type DownloadJobLog, type FailedJobLog, readFailedCheckLogs } from "#check-kit/pull-request/failed-logs"
import type { RunGitHub } from "#dev-mcp/github"

/**
 * The interval between two reads while waiting: 45 seconds.
 *
 * Each read is three `gh` calls, and a `Test` run takes 15 to 30 minutes on this host,
 * so the interval adds at most 45 seconds to a wait of that length.
 */
export const DEFAULT_PULL_REQUEST_POLL_SECONDS = 45

/**
 * The default bound on a wait: 40 minutes.
 *
 * The `Test` workflow on pull requests #3145, #3146, #3155, #3172 and #3178 took
 * 15 to 30 minutes on this host on 2026-11-20.
 * The extra 10 minutes covers a job that waits for a runner held by another run.
 */
export const DEFAULT_PULL_REQUEST_WAIT_MINUTES = 40

/**
 * The exit statuses of `mwops pr status` and `mwops pr wait`.
 */
export const PullRequestExit = {
	/**
	 * Every check concluded, and none failed.
	 */
	Passed: 0,
	/**
	 * At least one check failed or was cancelled, whether or not others are still pending.
	 */
	Failed: 1,
	/**
	 * At least one check is still pending and zero have failed: for `wait`, when the bound expired.
	 */
	Pending: 3,
	/**
	 * The checks stayed unread.
	 */
	Unread: 4,
	/**
	 * The head has zero checks, because of a merge conflict or because none started.
	 */
	NoChecks: 5,
} as const

/**
 * The services a status read goes through, injected by a test.
 */
export interface PullRequestStatusServices {
	run?: RunGitHub
	download?: DownloadJobLog
	readAnnotations?: ReadCheckAnnotations
	logDirectory?: string
	clock?: ClockLike
	/**
	 * Read the checks.
	 *
	 * The default is {@link readPullRequestChecks} over `run`.
	 */
	readChecks?: (pullRequestNumber: number) => Promise<PullRequestChecksReading>
}

/**
 * One status: the reading, the failed jobs' logs when a check failed, and the exit status.
 */
export interface PullRequestStatus {
	reading: PullRequestChecksReading
	/**
	 * One entry per failed check, read from its job log, or empty when no check failed.
	 */
	failedLogs: FailedJobLog[]
	exitCode: number
}

/**
 * How a wait ended, beside the last status.
 *
 * - `concluded`: zero checks pending.
 * - `failed-early`: a check failed or was cancelled while others were still pending.
 *   The wait ends at the first such read, because the pull request cannot pass after it.
 * - `expired`: the bound expired with a check pending and zero checks failed.
 * - `unread`: the bound expired while the checks were unread.
 * - `no-checks`: the head has a merge conflict, or no check started within the bound.
 */
export interface PullRequestWait extends PullRequestStatus {
	outcome: "concluded" | "failed-early" | "expired" | "unread" | "no-checks"
	waitedMs: number
	maxWaitMs: number
	reads: number
}

function exitCodeOf(reading: PullRequestChecksReading): number {
	switch (reading.condition) {
		case ChecksCondition.Passed:
			return PullRequestExit.Passed
		case ChecksCondition.Failed:
			return PullRequestExit.Failed
		case ChecksCondition.Pending:
			return PullRequestExit.Pending
		case ChecksCondition.NoChecks:
			return PullRequestExit.NoChecks
		default:
			return PullRequestExit.Unread
	}
}

function reader(services: PullRequestStatusServices): (pullRequestNumber: number) => Promise<PullRequestChecksReading> {
	return services.readChecks ?? ((pullRequestNumber) => readPullRequestChecks(pullRequestNumber, services.run))
}

async function withFailedLogs(
	reading: PullRequestChecksReading,
	services: PullRequestStatusServices
): Promise<PullRequestStatus> {
	const failedLogs =
		reading.condition === ChecksCondition.Failed && reading.checks
			? await readFailedCheckLogs(reading.checks, {
					download: services.download,
					directory: services.logDirectory,
					readAnnotations: services.readAnnotations,
				})
			: []

	return { reading, failedLogs, exitCode: exitCodeOf(reading) }
}

/**
 * Read a pull request's checks once, and the failed jobs' logs when a check failed.
 */
export async function readPullRequestStatus(
	pullRequestNumber: number,
	services: PullRequestStatusServices = {}
): Promise<PullRequestStatus> {
	return withFailedLogs(await reader(services)(pullRequestNumber), services)
}

/**
 * Read a pull request's checks until one fails, zero are pending, or `maxWaitMs` passes.
 *
 * The first read that shows a failed or cancelled check ends the wait, with the other
 * checks still running, and the failed jobs' logs are read at that moment.
 *
 * A conflicting head ends the wait at once, because GitHub starts no run for it.
 * A head with zero checks and no conflict is read again, because its runs may not have started yet.
 */
export async function waitForPullRequestConclusion(
	pullRequestNumber: number,
	options: { maxWaitMs: number; pollMs?: number },
	services: PullRequestStatusServices = {}
): Promise<PullRequestWait> {
	const clock = services.clock ?? systemClock
	const pollMs = options.pollMs ?? DEFAULT_PULL_REQUEST_POLL_SECONDS * 1000
	const { maxWaitMs } = options
	const read = reader(services)
	const startedAt = clock.now()

	for (let reads = 1; ; reads++) {
		const reading = await read(pullRequestNumber)
		const waitedMs = clock.now() - startedAt
		const end = (outcome: PullRequestWait["outcome"]) => ({ outcome, waitedMs, maxWaitMs, reads })

		if (reading.condition === ChecksCondition.Passed) {
			return { ...(await withFailedLogs(reading, services)), ...end("concluded") }
		}

		if (reading.condition === ChecksCondition.Failed) {
			const outcome = reading.counts?.pending ? "failed-early" : "concluded"

			return { ...(await withFailedLogs(reading, services)), ...end(outcome) }
		}

		if (reading.condition === ChecksCondition.NoChecks && reading.conflicting) {
			return { ...(await withFailedLogs(reading, services)), ...end("no-checks") }
		}

		if (waitedMs >= maxWaitMs) {
			const outcome =
				reading.condition === ChecksCondition.Unread
					? "unread"
					: reading.condition === ChecksCondition.NoChecks
						? "no-checks"
						: "expired"

			return { ...(await withFailedLogs(reading, services)), ...end(outcome) }
		}

		await clock.sleep(Math.min(pollMs, maxWaitMs - waitedMs))
	}
}

/**
 * The human view: one summary line, each check that didn't pass, then each
 * failed check's failing tests and log path.
 */
export function renderPullRequestStatus(status: PullRequestStatus, wait?: PullRequestWait): string[] {
	const { reading } = status
	const counts = reading.counts

	const summary = [
		`#${reading.number} ${reading.state.toLowerCase()} head ${reading.headCommit.slice(0, 10)} into ${reading.baseBranch}`,
		`mergeable ${reading.mergeable}, merge state ${reading.mergeState}`,
		counts
			? `checks ${reading.condition}: ${counts.pass} pass, ${counts.fail} fail, ${counts.pending} pending, ${counts.skipping} skipping, ${counts.cancel} cancel`
			: `checks unread: ${reading.checksError}`,
	]

	if (wait) {
		summary.push(
			wait.outcome === "concluded"
				? `concluded after ${Math.round(wait.waitedMs / 1000)} s`
				: wait.outcome === "failed-early"
					? `a check failed after ${Math.round(wait.waitedMs / 1000)} s with ${counts?.pending ?? 0} still pending`
					: `${wait.outcome} after ${Math.round(wait.waitedMs / 1000)} s of a ${Math.round(wait.maxWaitMs / 60_000)}-minute bound`
		)
	}

	const lines = [summary.join("; ")]

	if (reading.noChecksReason) {
		lines.push(`no checks: ${reading.noChecksReason}`)
	}

	for (const check of reading.checks ?? []) {
		if (checkDidNotPass(check)) {
			lines.push(`  ${check.bucket} ${check.workflow} / ${check.name} (${check.state}) ${check.link}`)
		}
	}

	for (const log of status.failedLogs) {
		lines.push(log.jobID == null ? `${log.job}: no job log` : `${log.job}: log ${log.logPath ?? "(not downloaded)"}`)

		if (!log.parsed) {
			lines.push(`  unparsed: ${log.reason}`)
		}

		for (const annotation of log.annotations?.read ? log.annotations.annotations : []) {
			lines.push(`  ${describeAnnotation(annotation)}`)
		}

		for (const test of log.failingTests) {
			lines.push(`  FAIL ${test.file}${test.name ? ` > ${test.name}` : ""}`)

			if (test.firstErrorLine) {
				lines.push(`    ${test.firstErrorLine}`)
			}
		}

		for (const check of log.failingChecks) {
			lines.push(`  failing: ${check}`)
		}

		if (!log.failingTests.length) {
			for (const line of log.errorLines) {
				lines.push(`    ${line}`)
			}
		}
	}

	return lines
}
