// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { git } from "@mailwoman/core/repo/git"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
	assertValeClean,
	assertValeCleanDiff,
	replaceTaskBlock,
	resolveCheckout,
	type GitHubIssue,
	type RunGitHub,
} from "#dev-mcp/github"
import { JobRegistry } from "#dev-mcp/process/jobs"
import { stubEngineRegistry } from "#dev-mcp/test/stub-registry"
import { githubTools } from "#dev-mcp/tools"

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

	it("checks a line the replacement introduces", async () => {
		await expect(
			assertValeCleanDiff("Kept line.", "Kept line.\nNew line.", async (text) => [
				{ Check: "styles.Rule", Message: "Rewrite this.", Severity: "error", Match: text, Line: 1 },
			])
		).rejects.toThrow(/styles\.Rule at line 2/)
	})

	it("passes a line the replacement preserves, whatever a later rule says about it", async () => {
		// A rule that lands after an issue is written would otherwise refuse every edit to it.
		const held = "A sentence a later rule refuses."

		await expect(
			assertValeCleanDiff(held, `${held}\n${held}`, async (text) => [
				{ Check: "styles.Rule", Message: "Rewrite this.", Severity: "error", Match: text, Line: 1 },
			])
		).resolves.toBeUndefined()
	})

	it("runs no check when the replacement adds no line", async () => {
		let ran = false

		await assertValeCleanDiff("One.\nTwo.", "One.", async () => {
			ran = true

			return []
		})

		expect(ran).toBe(false)
	})

	it("reports the line number in the replacement rather than in the added-line document", async () => {
		// Vale numbers its lines against the text it was handed.
		// That text holds only the added lines.
		await expect(
			assertValeCleanDiff("Kept.", "Kept.\nFirst added.\nSecond added.", async () => [
				{ Check: "styles.Rule", Message: "Rewrite this.", Severity: "error", Match: "Second added.", Line: 2 },
			])
		).rejects.toThrow(/styles\.Rule at line 3/)
	})

	it("updates only the marker-owned task block", () => {
		const body = `Before\n${COMPLETE_BODY}\nAfter`
		const next = replaceTaskBlock(body, "- [ ] Replacement.")

		expect(next).toBe(
			"Before\n## Task list\n\n<!-- todo-sync:begin -->\n- [ ] Replacement.\n<!-- todo-sync:end -->\nAfter"
		)
	})
})

describe("GitHub MCP tools", () => {
	it("comments on a pull request that closes no issue", async () => {
		const cwd = fixtures.use(await temporaryDirectory("mw-pr-comment-")).path
		const run: RunGitHub = vi.fn(async () => "https://github.com/sister-software/mailwoman/pull/2727#issuecomment-1\n")

		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: cwd.toString() }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined }
		)

		const result = await tool.handler({
			action: "append_comment",
			pull_request_number: 2727,
			body: "@dependabot rebase",
		})

		expect(run).toHaveBeenCalledWith(
			["pr", "comment", "2727", "--repo", "sister-software/mailwoman", "--body", "@dependabot rebase"],
			{ cwd: cwd.toString() }
		)

		expect(result).toEqual({
			action: "append_comment",
			pull_request_number: 2727,
			comment_url: "https://github.com/sister-software/mailwoman/pull/2727#issuecomment-1",
		})
	})

	it("creates a pull request that closes no issue, and reads no issue", async () => {
		const calls: string[][] = []

		const run: RunGitHub = vi.fn(async (args) => {
			calls.push(args)

			if (args[1] === "create") return "https://github.com/sister-software/mailwoman/pull/2402\n"

			return stringifyJSON({ number: 2402, headRefName: "feature/test", baseRefName: "main", state: "OPEN" })
		})

		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: process.cwd() }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined, branch: async () => "feature/test" }
		)

		await tool.handler({
			action: "create",
			title: "Title",
			summary: "Summary.",
			evidence: "Evidence.",
		})

		const createArgs = calls.find((args) => args[0] === "pr" && args[1] === "create")!

		expect(createArgs[createArgs.indexOf("--body") + 1]).not.toContain("Closes")
		expect(calls.some((args) => args[0] === "issue")).toBe(false)
	})

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
			{ registry: stubEngineRegistry({ repoRoot: cwd.toString() }), jobs: new JobRegistry(), startedAt: Date.now() },
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
		await expect(readLocalTextFile(cwd(".claude", "state", "linked-issue"))).resolves.toBe("2365\n")
	})

	it("creates a PR that closes its issue while the issue has unchecked tasks", async () => {
		const calls: string[][] = []

		const run: RunGitHub = vi.fn(async (args) => {
			calls.push(args)

			if (args[0] === "issue") return rawIssue(replaceTaskBlock(COMPLETE_BODY, "- [ ] Pending."))

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

		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: process.cwd() }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined, branch: async () => "feature/test" }
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
		expect(calls.some((args) => args[0] === "issue" && args[1] === "edit")).toBe(false)
	})

	it("creates a PR from the branch of a named worktree checkout", async () => {
		const { repo, worktree } = await repositoryWithWorktree("feature/worktree")
		const calls: string[][] = []

		const run: RunGitHub = vi.fn(async (args) => {
			calls.push(args)

			if (args[0] === "issue") return rawIssue(COMPLETE_BODY)

			if (args[1] === "create") return "https://github.com/sister-software/mailwoman/pull/2401\n"

			return stringifyJSON({ number: 2401, headRefName: "feature/worktree", baseRefName: "main", state: "OPEN" })
		})

		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: repo }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined }
		)

		await tool.handler({
			action: "create",
			issue_number: 2365,
			checkout: worktree,
			title: "Add GitHub tools",
			summary: "The development MCP creates pull requests.",
			evidence: "The unit test covers creation.",
			completion_assertions: [{ text: "CI passes.", completed: true }],
		})

		const createArgs = calls.find((args) => args[0] === "pr" && args[1] === "create")!

		expect(createArgs[createArgs.indexOf("--head") + 1]).toBe("feature/worktree")
	})

	it("refuses a checkout that belongs to another repository", async () => {
		const { repo } = await repositoryWithWorktree("feature/one")
		const { repo: other } = await repositoryWithWorktree("feature/two")

		await expect(resolveCheckout(repo, other)).rejects.toThrow(/is not a checkout of the repository/)
		await expect(resolveCheckout(repo, "relative/path")).rejects.toThrow(/absolute path/)
		await expect(resolveCheckout(repo)).resolves.toBe(repo)
	})
})

/**
 * A repository with one empty commit and a worktree on `branch`, both inside a disposable directory.
 */
async function repositoryWithWorktree(branch: string): Promise<{ repo: string; worktree: string }> {
	const identity = ["-c", "user.email=test@example.com", "-c", "user.name=Test"]

	const root = fixtures.use(await temporaryDirectory("mw-github-worktree-")).path

	const repo = root("repo").toString()
	const worktree = root("worktree").toString()

	await makeDirectories(repo)
	await git(["init", "--quiet", "--initial-branch=main"], repo)
	await git([...identity, "commit", "--quiet", "--allow-empty", "-m", "init"], repo)
	await git(["worktree", "add", "--quiet", "-b", branch, worktree], repo)

	return { repo, worktree }
}
