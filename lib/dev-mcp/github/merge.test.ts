// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_pull_request`'s `merge` over a stubbed `gh`: each condition's refusal runs no merge,
 * and a merge that every condition admits squashes at the checked head and keeps the branch.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { afterEach, describe, expect, it } from "vitest"

import type { RunGitHub } from "#dev-mcp/github"
import { recordPullRequestCompletion } from "#dev-mcp/github/merge"
import { JobRegistry } from "#dev-mcp/jobs"
import { stubEngineRegistry } from "#dev-mcp/test/stub-registry"
import { githubTools } from "#dev-mcp/tools"

let fixtures = new AsyncDisposableStack()

afterEach(async () => {
	await fixtures.disposeAsync()
	fixtures = new AsyncDisposableStack()
})

const HEAD = "aac46b327a5ce15e23e53290946526f7aa77792e"

const OPEN_CLEAN = {
	number: 3182,
	title: "Add pull request tools",
	url: "https://github.com/sister-software/mailwoman/pull/3182",
	state: "OPEN",
	headRefOid: HEAD,
	headRefName: "dev-tools-3182",
	baseRefName: "main",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
}

const PASSED = [
	{
		bucket: "pass",
		completedAt: "2026-11-20T21:33:46Z",
		link: "https://github.com/sister-software/mailwoman/actions/runs/1/job/2",
		name: "test",
		startedAt: "2026-11-20T21:22:47Z",
		state: "SUCCESS",
		workflow: "Test",
	},
]

interface Scenario {
	view?: Partial<typeof OPEN_CLEAN>
	checks?: object[]
	/**
	 * The head `complete` recorded, or `null` for no record.
	 */
	completedHead?: string | null
}

async function mergeWith(scenario: Scenario): Promise<{ result: Promise<unknown>; calls: string[][] }> {
	const repoRoot = fixtures.use(await temporaryDirectory("mw-pr-merge-")).path.toString()
	const calls: string[][] = []
	const completedHead = scenario.completedHead === undefined ? HEAD : scenario.completedHead

	if (completedHead) {
		await recordPullRequestCompletion(repoRoot, { pullRequestNumber: 3182, issueNumber: 3182, head: completedHead })
	}

	const run: RunGitHub = async (args) => {
		calls.push(args)

		if (args[0] === "pr" && args[1] === "view" && args.includes("state,mergeCommit,closingIssuesReferences")) {
			return stringifyJSON({
				state: "MERGED",
				mergeCommit: { oid: "merge-oid" },
				closingIssuesReferences: [{ number: 3182 }],
			})
		}

		if (args[0] === "pr" && args[1] === "view") return stringifyJSON({ ...OPEN_CLEAN, ...scenario.view })

		if (args[0] === "pr" && args[1] === "checks") return stringifyJSON(scenario.checks ?? PASSED)

		if (args[0] === "issue") return stringifyJSON({ state: "CLOSED" })

		return ""
	}

	const [, tool] = githubTools(
		{ registry: stubEngineRegistry({ repoRoot }), jobs: new JobRegistry(), startedAt: Date.now() },
		{ run }
	)

	return { result: tool.handler({ action: "merge", pull_request_number: 3182 }), calls }
}

const mergeCalls = (calls: string[][]) => calls.filter((args) => args[1] === "merge")

describe("mwdev_pull_request merge", () => {
	it.each([
		["a closed pull request", { view: { state: "CLOSED" } }, /#3182 is closed/],
		["no completion record", { completedHead: null }, /`complete` has not succeeded for #3182/],
		[
			"a completion for an earlier head",
			{ completedHead: "old-head" },
			/succeeded for head old-head, and the current head is aac46b3/,
		],
		[
			"a pending check",
			{ checks: [{ ...PASSED[0], bucket: "pending", state: "IN_PROGRESS" }] },
			/1 pending, 0 failed and 0 cancelled/,
		],
		["a failed check", { checks: [{ ...PASSED[0], bucket: "fail", state: "FAILURE" }] }, /0 pending, 1 failed/],
		["a merge state other than CLEAN", { view: { mergeStateStatus: "BLOCKED" } }, /merge state is BLOCKED/],
	] as const)("refuses %s and runs no merge", async (_label, scenario, message) => {
		const { result, calls } = await mergeWith(scenario as Scenario)

		await expect(result).rejects.toThrow(message)
		expect(mergeCalls(calls)).toEqual([])
	})

	it("squash-merges at the checked head, keeps the branch, and reports the merge commit and the issue's state", async () => {
		const { result, calls } = await mergeWith({})

		await expect(result).resolves.toMatchObject({
			action: "merge",
			head: HEAD,
			state: "MERGED",
			mergeCommit: "merge-oid",
			linkedIssues: [{ number: 3182, state: "CLOSED" }],
		})

		expect(mergeCalls(calls)).toEqual([
			["pr", "merge", "3182", "--repo", "sister-software/mailwoman", "--squash", "--match-head-commit", HEAD],
		])
	})
})
