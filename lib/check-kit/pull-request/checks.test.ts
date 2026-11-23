// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The checks reader over recorded `gh` output: all passed, one failed while `gh` exits 1,
 * pending while `gh` exits 8, zero checks on a conflicting head, and no JSON at all.
 */

import { stringifyJSON } from "@mailwoman/core/values/json"
import { describe, expect, it } from "vitest"

import { ChecksCondition, readPullRequestChecks } from "#check-kit/pull-request/checks"
import type { RunGitHub } from "#dev-mcp/github"

const VIEW = {
	number: 3178,
	title: "data: report each layer database's manifest",
	url: "https://github.com/sister-software/mailwoman/pull/3178",
	state: "OPEN",
	headRefOid: "ba30ffad335becdee4fd581ce10e706d493ae60e",
	headRefName: "data-layer-report-3170",
	baseRefName: "main",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
}

function check(name: string, bucket: string, state: string, job: number): Record<string, string> {
	return {
		bucket,
		completedAt: bucket === "pending" ? "0001-01-01T00:00:00Z" : "2026-11-20T21:33:46Z",
		link: `https://github.com/sister-software/mailwoman/actions/runs/44819636368/job/${job}`,
		name,
		startedAt: "2026-11-20T21:22:47Z",
		state,
		workflow: "Test",
	}
}

/**
 * A `gh` failure as `runFile` rejects with one: the exit code and both streams.
 */
function exited(code: number, stdout: string, stderr: string): Error {
	return Object.assign(new Error(`Command failed: gh pr checks (exit ${code})`), { code, stdout, stderr })
}

function stubGitHub(view: object, checks: () => string): RunGitHub {
	return async (args) => (args[1] === "view" ? stringifyJSON(view) : checks())
}

describe("readPullRequestChecks", () => {
	it("reports every check passed, with the run and job ids read from each link", async () => {
		const reading = await readPullRequestChecks(
			3178,
			stubGitHub(VIEW, () =>
				stringifyJSON([check("test", "pass", "SUCCESS", 136_582_908_321), check("deploy", "skipping", "SKIPPED", 2)])
			)
		)

		expect(reading.condition).toBe(ChecksCondition.Passed)
		expect(reading.headCommit).toBe(VIEW.headRefOid)
		expect(reading.mergeState).toBe("CLEAN")
		expect(reading.checks?.[0]).toMatchObject({ runID: 44_819_636_368, jobID: 136_582_908_321, bucket: "pass" })
	})

	it("reads the JSON gh prints when it exits 1 for a failed check", async () => {
		const reading = await readPullRequestChecks(
			3172,
			stubGitHub(VIEW, () => {
				throw exited(
					1,
					stringifyJSON([check("unit-fast", "fail", "FAILURE", 1), check("smoke", "pass", "SUCCESS", 2)]),
					""
				)
			})
		)

		expect(reading.condition).toBe(ChecksCondition.Failed)
		expect(reading.counts).toMatchObject({ fail: 1, pass: 1 })
	})

	it("reads the JSON gh prints when it exits 8 for a pending check", async () => {
		const reading = await readPullRequestChecks(
			3182,
			stubGitHub(VIEW, () => {
				throw exited(8, stringifyJSON([check("unit-slow", "pending", "IN_PROGRESS", 1)]), "")
			})
		)

		expect(reading.condition).toBe(ChecksCondition.Pending)
		expect(reading.checks?.[0]?.completedAt).toBeNull()
	})

	it("reports a failed check beside pending ones as failed, the state pull request #3189 was in", async () => {
		const reading = await readPullRequestChecks(
			3189,
			stubGitHub(VIEW, () => {
				throw exited(
					8,
					stringifyJSON([
						check("static", "fail", "FAILURE", 1),
						check("unit-slow", "pending", "IN_PROGRESS", 2),
						check("unit-fast", "pass", "SUCCESS", 3),
					]),
					""
				)
			})
		)

		expect(reading.condition).toBe(ChecksCondition.Failed)
		expect(reading.counts).toMatchObject({ fail: 1, pending: 1, pass: 1 })
	})

	it("reports zero checks on a conflicting head as their own condition, with the reason", async () => {
		const reading = await readPullRequestChecks(
			3100,
			stubGitHub({ ...VIEW, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, () => {
				throw exited(1, "", "no checks reported on the 'feature' branch\n")
			})
		)

		expect(reading.condition).toBe(ChecksCondition.NoChecks)
		expect(reading.conflicting).toBe(true)
		expect(reading.noChecksReason).toContain("conflicts with main")
		expect(reading.counts).toMatchObject({ pass: 0, fail: 0, pending: 0 })
	})

	it("reports the checks as unread when gh printed no JSON, rather than as zero checks", async () => {
		const reading = await readPullRequestChecks(
			3100,
			stubGitHub(VIEW, () => {
				throw exited(1, "", "error connecting to api.github.com\n")
			})
		)

		expect(reading.condition).toBe(ChecksCondition.Unread)
		expect(reading.checks).toBeNull()
		expect(reading.counts).toBeNull()
		expect(reading.checksError).toBe("error connecting to api.github.com")
	})
})
