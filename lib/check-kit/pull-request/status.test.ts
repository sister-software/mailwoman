// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The wait over a fake clock and a scripted sequence of readings, one test per exit status,
 * and the human view of a failed CodeQL check through its recorded annotations.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { readCheckRunAnnotations } from "#check-kit/pull-request/annotations"
import { ChecksCondition, type PullRequestChecksReading } from "#check-kit/pull-request/checks"
import {
	PullRequestExit,
	readPullRequestStatus,
	renderPullRequestStatus,
	waitForPullRequestConclusion,
} from "#check-kit/pull-request/status"

function reading(
	condition: PullRequestChecksReading["condition"],
	overrides: Partial<PullRequestChecksReading> = {}
): PullRequestChecksReading {
	const unread = condition === ChecksCondition.Unread
	const bucket = condition === "failed" ? "fail" : condition === "pending" ? "pending" : "pass"

	const checks =
		unread || condition === ChecksCondition.NoChecks
			? []
			: [
					{
						workflow: "Test",
						name: "unit-fast",
						state: "X",
						bucket,
						link: "https://github.com/sister-software/mailwoman/actions/runs/1/job/2",
						runID: 1,
						jobID: 2,
						checkRunID: null,
						startedAt: null,
						completedAt: null,
					} as const,
				]

	return {
		number: 3182,
		title: "t",
		url: "u",
		state: "OPEN",
		headCommit: "abc",
		headBranch: "b",
		baseBranch: "main",
		mergeable: "MERGEABLE",
		mergeState: "CLEAN",
		conflicting: false,
		condition,
		checks: unread ? null : checks,
		checksError: unread ? "error connecting to api.github.com" : null,
		noChecksReason: condition === ChecksCondition.NoChecks ? "none yet" : null,
		counts: unread ? null : { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0, [bucket]: checks.length },
		...overrides,
	}
}

/**
 * Wait over the given readings, the last one repeating, with a 10-minute bound and a 1-minute poll.
 */
async function waitOver(readings: PullRequestChecksReading[]) {
	await using scratch = await temporaryDirectory("pr-wait-test-")
	const clock = createFakeClock()
	let index = 0

	return await waitForPullRequestConclusion(
		3182,
		{ maxWaitMs: 10 * 60_000, pollMs: 60_000 },
		{
			clock,
			readChecks: async () => readings[Math.min(index++, readings.length - 1)]!,
			download: async () =>
				"unit-fast\tTest (fast)\t2026-11-20T19:49:50.5Z ##[error]Process completed with exit code 1.",
			logDirectory: scratch.path().toString(),
		}
	)
}

describe("waitForPullRequestConclusion", () => {
	it("exits 0 once the pending checks pass", async () => {
		const wait = await waitOver([reading("pending"), reading("pending"), reading("passed")])

		expect(wait).toMatchObject({ outcome: "concluded", exitCode: PullRequestExit.Passed, reads: 3 })
		expect(wait.waitedMs).toBe(2 * 60_000)
	})

	it("exits 1 when a check fails, and reads that job's log", async () => {
		const wait = await waitOver([reading("pending"), reading("failed")])

		expect(wait).toMatchObject({ outcome: "concluded", exitCode: PullRequestExit.Failed })
		expect(wait.failedLogs.map((log) => [log.job, log.parsed])).toEqual([["unit-fast", false]])
	})

	it("exits 3 when the bound expires with a check pending", async () => {
		const wait = await waitOver([reading("pending")])

		expect(wait).toMatchObject({ outcome: "expired", exitCode: PullRequestExit.Pending })
		expect(wait.waitedMs).toBe(10 * 60_000)
	})

	it("exits 4 when the checks stay unread through the bound", async () => {
		const wait = await waitOver([reading("unread")])

		expect(wait).toMatchObject({ outcome: "unread", exitCode: PullRequestExit.Unread })
	})

	it("exits 5 at once for a conflicting head with zero checks", async () => {
		const wait = await waitOver([reading("no-checks", { conflicting: true })])

		expect(wait).toMatchObject({ outcome: "no-checks", exitCode: PullRequestExit.NoChecks, reads: 1, waitedMs: 0 })
	})

	it("prints the annotations of a failed check that has no job log, and keeps it failed", async () => {
		const output = await readLocalTextFile(
			repoRootPath("test", "fixtures", "check-kit", "check-run-annotations-codeql.json")
		)

		const codeQL = {
			workflow: "",
			name: "CodeQL",
			state: "FAILURE",
			bucket: "fail",
			link: "https://github.com/sister-software/mailwoman/runs/136612629639",
			runID: null,
			jobID: null,
			checkRunID: 136_612_629_639,
			startedAt: null,
			completedAt: null,
		} as const

		const status = await readPullRequestStatus(3183, {
			readChecks: async () =>
				reading("failed", { checks: [codeQL], counts: { pass: 0, fail: 1, pending: 0, skipping: 0, cancel: 0 } }),
			readAnnotations: (id) => readCheckRunAnnotations(id, async () => output),
		})

		expect(status.exitCode).toBe(PullRequestExit.Failed)

		const lines = renderPullRequestStatus(status)

		expect(lines).toContain("CodeQL: no job log")

		expect(lines).toContain(
			"  failure lib/dev-mcp/tools/sql.ts:41: Inefficient regular expression: This part of the regular expression may cause exponential backtracking on strings starting with '/*' and containing many repetitions of '*//*'."
		)

		const empty = await readPullRequestStatus(3183, {
			readChecks: async () =>
				reading("failed", { checks: [codeQL], counts: { pass: 0, fail: 1, pending: 0, skipping: 0, cancel: 0 } }),
			readAnnotations: async (id) => ({ checkRunID: id, read: true, annotations: [] }),
		})

		expect(empty.exitCode).toBe(PullRequestExit.Failed)
		expect(empty.failedLogs[0]?.reason).toContain("holds zero annotations")
	})

	it("exits 5 when no check starts within the bound", async () => {
		const wait = await waitOver([reading("no-checks")])

		expect(wait).toMatchObject({ outcome: "no-checks", exitCode: PullRequestExit.NoChecks })
		expect(wait.waitedMs).toBe(10 * 60_000)
	})
})
