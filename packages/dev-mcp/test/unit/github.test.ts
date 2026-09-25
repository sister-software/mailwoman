/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	assertValeClean,
	replaceTaskBlock,
	taskBlockIsComplete,
	type GitHubIssue,
	type RunGitHub,
} from "@mailwoman/dev-mcp/github"
import { JobRegistry, type Job } from "@mailwoman/dev-mcp/jobs"
import { githubTools } from "@mailwoman/dev-mcp/tools"
import { afterEach, describe, expect, it, vi } from "vitest"

let fixtures = new AsyncDisposableStack()

afterEach(async () => {
	await fixtures.disposeAsync()
	fixtures = new AsyncDisposableStack()
})

function issue(body: string, state: GitHubIssue["state"] = "OPEN"): GitHubIssue {
	return {
		number: 2365,
		title: "Feature: GitHub tools",
		url: "https://github.com/sister-software/mailwoman/issues/2365",
		state,
		issueType: null,
		author: { login: "maintainer", name: "Maintainer" },
		assignees: [],
		labels: [],
		milestone: null,
		createdAt: "2026-09-25T00:00:00Z",
		updatedAt: "2026-09-25T00:00:00Z",
		closedAt: null,
		body,
	}
}

function rawIssue(body: string, state: GitHubIssue["state"] = "OPEN"): string {
	return stringifyJSON({ ...issue(body, state), issueType: null })
}

const COMPLETE_BODY = [
	"## Task list",
	"",
	"<!-- todo-sync:begin -->",
	"- [x] First assertion.",
	"- [x] Final assertion.",
	"<!-- todo-sync:end -->",
].join("\n")

describe("GitHub prose and task blocks", () => {
	it("reports a Vale error before a GitHub mutation can run", async () => {
		await expect(
			assertValeClean("Body", async () => [
				{ Check: "Mailwoman.Rule", Message: "Rewrite this.", Severity: "error", Match: "Body", Line: 1 },
			])
		).rejects.toThrow(/Mailwoman\.Rule at line 1/)
	})

	it("updates only the marker-owned task block", () => {
		const body = `Before\n${COMPLETE_BODY}\nAfter`
		const next = replaceTaskBlock(body, "- [ ] Replacement.")

		expect(next).toBe(
			"Before\n## Task list\n\n<!-- todo-sync:begin -->\n- [ ] Replacement.\n<!-- todo-sync:end -->\nAfter"
		)

		expect(taskBlockIsComplete(next)).toBe(false)
		expect(taskBlockIsComplete(body)).toBe(true)
	})
})

describe("GitHub MCP tools", () => {
	it("creates a checked issue and links the checkout", async () => {
		const cwd = fixtures.use(await temporaryDirectory("mw-github-tool-")).path
		const calls: string[][] = []
		let createdBody = ""

		const run: RunGitHub = vi.fn(async (args) => {
			calls.push(args)

			if (args[0] === "issue" && args[1] === "create") {
				createdBody = args[args.indexOf("--body") + 1]!

				return "https://github.com/sister-software/mailwoman/issues/2365\n"
			}

			return rawIssue(createdBody)
		})

		const [tool] = githubTools(
			{ registry: { repoRoot: cwd.toString() } as never, jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined }
		)

		await tool.handler({
			action: "create",
			title: "GitHub tools",
			area: "infrastructure",
			change: "The tool creates issues.",
			evidence: "The server has no issue operation.",
			scope: "The development MCP changes.",
			tradeoff: "The operation requires GitHub authentication.",
			tasks: [{ text: "The test passes.", completed: false }],
		})

		expect(calls[0]).toContain("--body")
		expect(calls[0]).not.toContain("--body-file")
		expect(createdBody).toContain("<!-- todo-sync:begin -->\n- [ ] The test passes.\n<!-- todo-sync:end -->")
		expect(await readLocalTextFile(cwd(".claude", "state", "linked-issue"))).toBe("2365\n")
	})

	it("refuses PR creation while the linked issue has an incomplete task", async () => {
		const run: RunGitHub = vi.fn(async () => rawIssue(replaceTaskBlock(COMPLETE_BODY, "- [ ] Pending.")))

		const [, tool] = githubTools(
			{ registry: { repoRoot: process.cwd() } as never, jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined, branch: () => "feature/test" }
		)

		await expect(
			tool.handler({
				action: "create",
				issue_number: 2365,
				title: "Add GitHub tools",
				summary: "The development MCP creates pull requests.",
				evidence: "The unit test covers creation.",
				completion_assertions: [{ text: "CI passes.", completed: true }],
			})
		).rejects.toThrow(/incomplete todo-sync task list/)
	})

	it("creates a PR and starts its CI monitor", async () => {
		const calls: string[][] = []

		const run: RunGitHub = vi.fn(async (args) => {
			calls.push(args)

			if (args[0] === "issue") return rawIssue(COMPLETE_BODY)

			if (args[1] === "create") return "https://github.com/sister-software/mailwoman/pull/2400\n"

			return stringifyJSON({
				number: 2400,
				title: "Add GitHub tools",
				url: "https://github.com/sister-software/mailwoman/pull/2400",
				state: "OPEN",
				body: "Closes #2365.",
				headRefName: "feature/test",
				baseRefName: "main",
			})
		})

		const jobs = new JobRegistry()

		const start = vi.spyOn(jobs, "start").mockReturnValue({
			jobID: "job-1",
			label: "CI for pull request #2400",
			command: "gh",
			args: [],
			state: "running",
			startedAt: Date.now(),
			endedAt: null,
			exitCode: null,
			stdout: "",
			stderr: "",
			child: null,
		} satisfies Job)

		const [, tool] = githubTools(
			{ registry: { repoRoot: process.cwd() } as never, jobs, startedAt: Date.now() },
			{ run, lint: async () => undefined, branch: () => "feature/test" }
		)

		await tool.handler({
			action: "create",
			issue_number: 2365,
			title: "Add GitHub tools",
			summary: "The development MCP creates pull requests.",
			evidence: "The unit test covers creation.",
			completion_assertions: [{ text: "CI passes.", completed: true }],
		})

		const createArgs = calls.find((args) => args[0] === "pr" && args[1] === "create")!
		const body = createArgs[createArgs.indexOf("--body") + 1]!

		expect(body).toContain("Closes #2365.")

		expect(start).toHaveBeenCalledWith(
			"CI for pull request #2400",
			process.execPath,
			expect.arrayContaining([expect.stringContaining("github/ci-monitor.ts"), "--pull-request", "2400"]),
			process.cwd()
		)
	})
})
