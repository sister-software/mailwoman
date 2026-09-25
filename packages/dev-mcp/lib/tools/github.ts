/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { z } from "zod"

import {
	assertValeClean,
	currentBranch,
	fetchGitHubIssue,
	fetchGitHubPullRequest,
	linkIssue,
	replaceTaskBlock,
	runGitHub,
	taskBlockIsComplete,
	type RunGitHub,
} from "#github/index"
import type { DevTool, DevToolDeps } from "#tool-kit"

const REPO = "sister-software/mailwoman"

const AREAS = [
	"evals",
	"training",
	"resolver",
	"geocoding",
	"corpus",
	"infrastructure",
	"postcode",
	"tokenizer",
	"street",
	"venue",
	"locality",
	"checks",
	"multilingual",
	"architecture",
	"neural",
	"record-matching",
	"documentation",
] as const

const TASK_SCHEMA = z.object({
	text: z.string().min(1),
	completed: z.boolean().default(false),
})

type Task = z.infer<typeof TASK_SCHEMA>

function renderTasks(tasks: Task[]): string {
	return tasks.map((task) => `- [${task.completed ? "x" : " "}] ${task.text}`).join("\n")
}

function featureBody(args: Record<string, unknown>): string {
	return [
		"## What changes",
		"",
		args["change"],
		"",
		"## Evidence the change is needed",
		"",
		args["evidence"],
		"",
		"## Scope",
		"",
		args["scope"],
		"",
		"## Tradeoff",
		"",
		args["tradeoff"],
		"",
		"## Task list",
		"",
		"<!-- todo-sync:begin -->",
		renderTasks(args["tasks"] as Task[]),
		"<!-- todo-sync:end -->",
	].join("\n")
}

function pullRequestBody(issueNumber: number, summary: string, evidence: string, assertions: Task[]): string {
	return [
		`Closes #${issueNumber}.`,
		"",
		"## Summary",
		"",
		summary,
		"",
		"## Evidence",
		"",
		evidence,
		"",
		"## Completion assertions",
		"",
		renderTasks(assertions),
	].join("\n")
}

const ISSUE_CREATE_SCHEMA = z.object({
	action: z.literal("create"),
	title: z.string().min(1).describe("A factual title without the `Feature:` prefix."),
	area: z.enum(AREAS),
	change: z.string().min(1),
	evidence: z.string().min(1),
	scope: z.string().min(1),
	tradeoff: z.string().min(1),
	tasks: z.array(TASK_SCHEMA).min(1),
})

const ISSUE_SCHEMA = z.discriminatedUnion("action", [
	ISSUE_CREATE_SCHEMA,
	z.object({ action: z.literal("view"), issue_number: z.number().int().positive() }),
	z.object({
		action: z.literal("edit"),
		issue_number: z.number().int().positive(),
		title: z.string().min(1).optional(),
		body: z.string().min(1).optional(),
	}),
	z.object({
		action: z.literal("update_tasks"),
		issue_number: z.number().int().positive(),
		tasks: z.array(TASK_SCHEMA).min(1),
	}),
	z.object({
		action: z.literal("append_comment"),
		issue_number: z.number().int().positive(),
		body: z.string().min(1),
	}),
])

const ISSUE_INPUT_SCHEMA = z.object({
	action: z.enum(["create", "view", "edit", "update_tasks", "append_comment"]),
	issue_number: z.number().int().positive().optional(),
	title: z.string().min(1).optional(),
	area: z.enum(AREAS).optional(),
	change: z.string().min(1).optional(),
	evidence: z.string().min(1).optional(),
	scope: z.string().min(1).optional(),
	tradeoff: z.string().min(1).optional(),
	tasks: z.array(TASK_SCHEMA).min(1).optional(),
	body: z.string().min(1).optional(),
})

const PULL_REQUEST_SCHEMA = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("create"),
		issue_number: z.number().int().positive(),
		title: z.string().min(1),
		summary: z.string().min(1),
		evidence: z.string().min(1),
		completion_assertions: z.array(TASK_SCHEMA).min(1),
		base: z.string().min(1).default("main"),
	}),
	z.object({
		action: z.literal("view"),
		issue_number: z.number().int().positive(),
		pull_request_number: z.number().int().positive(),
	}),
	z.object({
		action: z.literal("edit"),
		issue_number: z.number().int().positive(),
		pull_request_number: z.number().int().positive(),
		title: z.string().min(1).optional(),
		body: z.string().min(1).optional(),
	}),
	z.object({
		action: z.literal("append_comment"),
		issue_number: z.number().int().positive(),
		pull_request_number: z.number().int().positive(),
		body: z.string().min(1),
	}),
])

const PULL_REQUEST_INPUT_SCHEMA = z.object({
	action: z.enum(["create", "view", "edit", "append_comment"]),
	issue_number: z.number().int().positive().describe("The issue this pull request closes."),
	pull_request_number: z.number().int().positive().optional(),
	title: z.string().min(1).optional(),
	summary: z.string().min(1).optional(),
	evidence: z.string().min(1).optional(),
	completion_assertions: z.array(TASK_SCHEMA).min(1).optional(),
	base: z.string().min(1).optional(),
	body: z.string().min(1).optional(),
})

export interface GitHubToolOverrides {
	run?: RunGitHub
	lint?: typeof assertValeClean
	branch?: (cwd: string) => string
}

export function githubTools(deps: DevToolDeps, overrides: GitHubToolOverrides = {}): [DevTool, DevTool] {
	const run = overrides.run ?? runGitHub
	const lint = overrides.lint ?? assertValeClean
	const branch = overrides.branch ?? currentBranch

	const issueTool: DevTool = {
		name: "mwdev_issue",
		description:
			"Create and maintain the feature issue that owns an implementation task. Creation enforces the repository " +
			"issue fields, Vale-checks the body, adds todo-sync markers, applies the area label, and links the checkout. " +
			"Edits and comments are also Vale-checked. `update_tasks` changes only the marker-owned block.",
		inputSchema: ISSUE_INPUT_SCHEMA,
		handler: async (raw) => {
			const cwd = deps.registry.repoRoot
			const request = ISSUE_SCHEMA.parse(raw)

			if (request.action === "create") {
				const body = featureBody(request)

				await lint(body)

				const url = (
					await run(
						[
							"issue",
							"create",
							"--repo",
							REPO,
							"--title",
							`Feature: ${request.title}`,
							"--label",
							"enhancement",
							"--label",
							request.area,
							"--body",
							body,
						],
						{ cwd }
					)
				).trim()

				const issueNumber = Number.parseInt(url.split("/").at(-1) ?? "", 10)

				if (!Number.isInteger(issueNumber)) throw new Error(`GitHub returned an unrecognized issue URL: ${url}`)

				await linkIssue(cwd, issueNumber)

				return { action: request.action, issue: await fetchGitHubIssue(REPO, issueNumber, run), linked: true }
			}

			if (request.action === "view") {
				return { action: request.action, issue: await fetchGitHubIssue(REPO, request.issue_number, run) }
			}

			if (request.action === "update_tasks") {
				const issue = await fetchGitHubIssue(REPO, request.issue_number, run)
				const body = replaceTaskBlock(issue.body, renderTasks(request.tasks))

				await lint(body)
				await run(["issue", "edit", String(request.issue_number), "--repo", REPO, "--body", body], { cwd })

				return { action: request.action, issue: await fetchGitHubIssue(REPO, request.issue_number, run) }
			}

			if (request.action === "append_comment") {
				await lint(request.body)

				const url = (
					await run(["issue", "comment", String(request.issue_number), "--repo", REPO, "--body", request.body], { cwd })
				).trim()

				return { action: request.action, issue_number: request.issue_number, comment_url: url }
			}

			if (!request.title && !request.body) throw new Error("An issue edit requires `title` or `body`.")

			if (request.body) {
				await lint(request.body)
			}

			await run(
				[
					"issue",
					"edit",
					String(request.issue_number),
					"--repo",
					REPO,
					...(request.title ? ["--title", request.title] : []),
					...(request.body ? ["--body", request.body] : []),
				],
				{ cwd }
			)

			return { action: request.action, issue: await fetchGitHubIssue(REPO, request.issue_number, run) }
		},
	}

	const pullRequestTool: DevTool = {
		name: "mwdev_pull_request",
		description:
			"Create and maintain the pull request that closes an implementation issue. Creation requires a completed " +
			"marker-owned issue task list, Vale-checks the PR body, creates the PR from the current branch, and starts a " +
			"tracked `gh pr checks --watch --fail-fast` job. Poll the returned job through `mwdev_job`.",
		inputSchema: PULL_REQUEST_INPUT_SCHEMA,
		handler: async (raw) => {
			const cwd = deps.registry.repoRoot
			const request = PULL_REQUEST_SCHEMA.parse(raw)

			if (request.action === "create") {
				const issue = await fetchGitHubIssue(REPO, request.issue_number, run)

				if (issue.state !== "OPEN") throw new Error(`Issue #${request.issue_number} is ${issue.state.toLowerCase()}.`)

				if (!taskBlockIsComplete(issue.body)) {
					throw new Error(`Issue #${request.issue_number} has an absent, empty, or incomplete todo-sync task list.`)
				}

				const head = branch(cwd)

				if (!head || head === request.base) {
					throw new Error(`Create the pull request from a branch other than ${request.base}.`)
				}

				const body = pullRequestBody(
					request.issue_number,
					request.summary,
					request.evidence,
					request.completion_assertions
				)

				await lint(body)

				const url = (
					await run(
						[
							"pr",
							"create",
							"--repo",
							REPO,
							"--base",
							request.base,
							"--head",
							head,
							"--title",
							request.title,
							"--body",
							body,
						],
						{ cwd }
					)
				).trim()

				const pullRequestNumber = Number.parseInt(url.split("/").at(-1) ?? "", 10)

				if (!Number.isInteger(pullRequestNumber)) {
					throw new TypeError(`GitHub returned an unrecognized pull-request URL: ${url}`)
				}

				const monitor = deps.jobs.start(
					`CI for pull request #${pullRequestNumber}`,
					process.execPath,
					[
						resolvePackagePath("@mailwoman/dev-mcp", "lib", "github", "ci-monitor.ts"),
						"--repo",
						REPO,
						"--pull-request",
						String(pullRequestNumber),
					],
					cwd
				)

				return {
					action: request.action,
					pull_request: await fetchGitHubPullRequest(REPO, pullRequestNumber, run),
					ci_monitor: deps.jobs.summarize(monitor),
				}
			}

			if (request.action === "view") {
				return {
					action: request.action,
					pull_request: await fetchGitHubPullRequest(REPO, request.pull_request_number, run),
				}
			}

			if (request.action === "append_comment") {
				await lint(request.body)

				const url = (
					await run(["pr", "comment", String(request.pull_request_number), "--repo", REPO, "--body", request.body], {
						cwd,
					})
				).trim()

				return { action: request.action, pull_request_number: request.pull_request_number, comment_url: url }
			}

			if (!request.title && !request.body) throw new Error("A pull-request edit requires `title` or `body`.")

			if (request.body) {
				await lint(request.body)
			}

			await run(
				[
					"pr",
					"edit",
					String(request.pull_request_number),
					"--repo",
					REPO,
					...(request.title ? ["--title", request.title] : []),
					...(request.body ? ["--body", request.body] : []),
				],
				{ cwd }
			)

			return {
				action: request.action,
				pull_request: await fetchGitHubPullRequest(REPO, request.pull_request_number, run),
			}
		},
	}

	return [issueTool, pullRequestTool]
}
