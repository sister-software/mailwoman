/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { git, workingTreeRoot } from "@mailwoman/core/git"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
	assertValeClean,
	assertValeCleanDiff,
	replaceTaskBlock,
	resolveCheckout,
	taskBlockIsComplete,
	type GitHubIssue,
	type RunGitHub,
} from "#github"
import { JobRegistry, type Job } from "#jobs"
import { stubEngineRegistry } from "#test/stub-registry"
import { githubTools } from "#tools"

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

		expect(taskBlockIsComplete(next)).toBe(false)
		expect(taskBlockIsComplete(body)).toBe(true)
	})
})

describe("GitHub MCP tools", () => {
	it("refuses completion while CI is pending and leaves the issue unchanged", async () => {
		const cwd = fixtures.use(await temporaryDirectory("mw-pr-pending-")).path
		const run: RunGitHub = vi.fn(async (args) => {
			if (args[1] === "view") return stringifyJSON({ state: "OPEN", headRefOid: "head-a" })
			return stringifyJSON([{ name: "test", bucket: "pending" }])
		})
		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: cwd.toString() }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run }
		)
		await expect(tool.handler({ action: "complete", issue_number: 2365, pull_request_number: 2400 })).rejects.toThrow(
			"unresolved"
		)
		expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(["edit"]), expect.anything())
	})

	it("completes the CI review task only after current-head checks pass", async () => {
		const cwd = fixtures.use(await temporaryDirectory("mw-pr-complete-")).path
		const task = "Review successful CI for PR #2400 on its current head."
		const body = COMPLETE_BODY.replace("<!-- todo-sync:end -->", `- [ ] ${task}\n<!-- todo-sync:end -->`)
		const run: RunGitHub = vi.fn(async (args) => {
			if (args[0] === "issue") return rawIssue(body)
			if (args[1] === "view") return stringifyJSON({ state: "OPEN", headRefOid: "head-a" })
			return stringifyJSON([{ name: "test", bucket: "pass" }])
		})
		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: cwd.toString() }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run }
		)
		expect(await tool.handler({ action: "complete", issue_number: 2365, pull_request_number: 2400 })).toMatchObject({
			handoff_ready: true,
		})
		expect(run).toHaveBeenCalledWith(
			expect.arrayContaining(["edit", "--body", body.replace(`- [ ] ${task}`, `- [x] ${task}`)]),
			{ cwd: cwd.toString() }
		)
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
		expect(await readLocalTextFile(cwd(".claude", "state", "linked-issue"))).toBe("2365\n")
	})

	it("refuses PR creation while the linked issue has an incomplete task", async () => {
		const run: RunGitHub = vi.fn(async () => rawIssue(replaceTaskBlock(COMPLETE_BODY, "- [ ] Pending.")))

		const [, tool] = githubTools(
			{ registry: stubEngineRegistry({ repoRoot: process.cwd() }), jobs: new JobRegistry(), startedAt: Date.now() },
			{ run, lint: async () => undefined, branch: async () => "feature/test" }
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
		const cwd = fixtures.use(await temporaryDirectory("mw-pr-ci-")).path
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
			{ registry: stubEngineRegistry({ repoRoot: cwd.toString() }), jobs, startedAt: Date.now() },
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

		expect(start).toHaveBeenCalledWith(
			"CI for pull request #2400",
			process.execPath,
			expect.arrayContaining([expect.stringContaining("github/ci-monitor.ts"), "--pull-request", "2400"]),
			cwd.toString()
		)
		expect(parseJSONStrict(await readLocalTextFile(cwd(".claude", "state", "tracked-ci.json")))).toEqual({
			repo: "sister-software/mailwoman",
			pullRequestNumber: 2400,
		})
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

		const jobs = new JobRegistry()

		const start = vi.spyOn(jobs, "start").mockReturnValue({
			jobID: "job-2",
			label: "CI for pull request #2401",
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
			{ registry: stubEngineRegistry({ repoRoot: repo }), jobs, startedAt: Date.now() },
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
		expect(start.mock.calls[0]![3]).toBe(await workingTreeRoot(worktree))
	})

	it("refuses a checkout that belongs to another repository", async () => {
		const { repo } = await repositoryWithWorktree("feature/one")
		const { repo: other } = await repositoryWithWorktree("feature/two")

		await expect(resolveCheckout(repo, other)).rejects.toThrow(/is not a checkout of the repository/)
		await expect(resolveCheckout(repo, "relative/path")).rejects.toThrow(/absolute path/)
		expect(await resolveCheckout(repo)).toBe(repo)
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
