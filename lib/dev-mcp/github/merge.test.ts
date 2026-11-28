// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `mwdev_pull_request`'s `merge` over a stubbed `gh`: a closed or conflicting pull request runs no
 * merge, and an open one squashes at the read head whatever its CI state, reporting that state.
 */

import { stringifyJSON } from "@mailwoman/core/values/json"
import { describe, expect, it } from "vitest"

import type { RunGitHub } from "#dev-mcp/github"
import { JobRegistry } from "#dev-mcp/process/jobs"
import { stubEngineRegistry } from "#dev-mcp/test/stub-registry"
import { githubTools } from "#dev-mcp/tools"

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

const CHECK = {
	bucket: "pass",
	completedAt: "2026-11-20T21:33:46Z",
	link: "https://github.com/sister-software/mailwoman/actions/runs/1/job/2",
	name: "test",
	startedAt: "2026-11-20T21:22:47Z",
	state: "SUCCESS",
	workflow: "Test",
}

interface Scenario {
	view?: Partial<typeof OPEN_CLEAN>
	checks?: object[]
}

function mergeWith(scenario: Scenario): { result: Promise<unknown>; calls: string[][] } {
	const calls: string[][] = []

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

		if (args[0] === "pr" && args[1] === "checks") return stringifyJSON(scenario.checks ?? [CHECK])

		if (args[0] === "issue") return stringifyJSON({ state: "CLOSED" })

		return ""
	}

	const [, tool] = githubTools(
		{ registry: stubEngineRegistry({ repoRoot: process.cwd() }), jobs: new JobRegistry(), startedAt: Date.now() },
		{ run }
	)

	return { result: tool.handler({ action: "merge", pull_request_number: 3182 }), calls }
}

const mergeCalls = (calls: string[][]) => calls.filter((args) => args[1] === "merge")

describe("mwdev_pull_request merge", () => {
	it.each([
		["a closed pull request", { view: { state: "CLOSED" } }, /#3182 is closed/],
		[
			"a pull request that conflicts with its base",
			{ view: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } },
			/conflicts with its base/,
		],
	] as const)("refuses %s and runs no merge", async (_label, scenario, message) => {
		const { result, calls } = mergeWith(scenario as Scenario)

		await expect(result).rejects.toThrow(message)
		expect(mergeCalls(calls)).toEqual([])
	})

	it("merges while a check is pending and reports the CI state it merged under", async () => {
		const { result, calls } = mergeWith({
			view: { mergeStateStatus: "UNSTABLE" },
			checks: [{ ...CHECK, bucket: "pending", state: "IN_PROGRESS" }],
		})

		await expect(result).resolves.toMatchObject({
			action: "merge",
			head: HEAD,
			state: "MERGED",
			mergeCommit: "merge-oid",
			checksAtMerge: "1 pending, 0 failed and 0 cancelled",
			linkedIssues: [{ number: 3182, state: "CLOSED" }],
		})

		expect(mergeCalls(calls)).toEqual([
			["pr", "merge", "3182", "--repo", "sister-software/mailwoman", "--squash", "--match-head-commit", HEAD],
		])
	})
})
