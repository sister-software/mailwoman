/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GitHub issue and pull-request operations shared by the development MCP tools and the todo hook.
 */

import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { gitCommonDirectory, workingTreeRoot } from "@mailwoman/core/git"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { isAbsolute, PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"

import { lintReply, type ValeAlert } from "#dev-mcp/hooks/vale/check-core"

/**
 * Marker that begins the task list owned by the task-intake workflow.
 */
export const TODO_SYNC_BEGIN = "<!-- todo-sync:begin -->"

/**
 * End marker for the task list owned by the task-intake workflow.
 */
export const TODO_SYNC_END = "<!-- todo-sync:end -->"

interface GitHubUser {
	login: string
	name: string | null
}

interface GitHubLabel {
	name: string
	color: string
}

interface GitHubMilestone {
	title: string
	dueOn: string | null
}

type GitHubIssueState = "OPEN" | "CLOSED"

export interface GitHubIssue {
	number: number
	title: string
	url: string
	state: GitHubIssueState
	issueType: string | null
	author: GitHubUser
	assignees: GitHubUser[]
	labels: GitHubLabel[]
	milestone: GitHubMilestone | null
	createdAt: string
	updatedAt: string
	closedAt: string | null
	body: string
}

const ISSUE_FIELDS = [
	"number",
	"title",
	"url",
	"state",
	"issueType",
	"author",
	"assignees",
	"labels",
	"milestone",
	"createdAt",
	"updatedAt",
	"closedAt",
	"body",
].join(",")

interface RawIssueType {
	name: string
}

interface RawGitHubIssue extends Omit<GitHubIssue, "issueType"> {
	issueType: RawIssueType | null
}

export interface GitHubPullRequest {
	number: number
	title: string
	url: string
	state: "OPEN" | "CLOSED" | "MERGED"
	body: string
	headRefName: string
	baseRefName: string
}

const PULL_REQUEST_FIELDS = ["number", "title", "url", "state", "body", "headRefName", "baseRefName"].join(",")

/**
 * Runs one GitHub CLI operation.
 */
export type RunGitHub = (args: string[], options?: { cwd?: string }) => Promise<string>

export const runGitHub: RunGitHub = async (args, options = {}) =>
	(
		await runFile("gh", args, {
			cwd: options.cwd,
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
		})
	).stdout

/**
 * Rejects prose that has an error-severity Vale finding.
 */
export async function assertValeClean(
	body: string,
	lint: (text: string) => Promise<ValeAlert[]> = lintReply
): Promise<void> {
	const errors = (await lint(body)).filter((alert) => alert.Severity === "error")

	if (!errors.length) return

	const findings = errors.map((alert) => `${alert.Check} at line ${alert.Line}: ${alert.Message}`).join("\n")

	throw new Error(`Vale rejected the GitHub prose:\n${findings}`)
}

/**
 * Line-for-line splitting options that match `String.prototype.split` on a line feed.
 *
 * `TextSpliterator` trims each row and drops an empty one by default.
 * Both would break a line comparison: a trimmed row no longer matches the body it came
 * from byte-for-byte, and a dropped row moves every line number after it.
 */
const BODY_LINES = { trim: false, skipEmpty: false } as const

/**
 * Rejects an error-severity Vale finding on a line the replacement introduces.
 *
 * A rule that lands after an issue is written makes every line of that issue's body a finding.
 * A whole-body check therefore refuses an edit until the author's earlier prose is rewritten
 * to rules it predates, and an edit that appends a task list should not require that rewrite.
 *
 * Only a line absent from `previous` reaches Vale here.
 * A finding reports its line number in `next`, so the message points at the line the
 * author is looking at rather than at a position in the added-line document.
 *
 * A replacement that adds no line passes without running Vale.
 */
export async function assertValeCleanDiff(
	previous: string,
	next: string,
	lint: (text: string) => Promise<ValeAlert[]> = lintReply
): Promise<void> {
	const held = TextSpliterator.from(previous, BODY_LINES).toSet()

	const added = TextSpliterator.from(next, BODY_LINES)
		.map((line, index) => ({ line, number: index + 1 }))
		.filter((entry) => !held.has(entry.line))
		.toArray()

	if (!added.length) return

	const errors = (await lint(added.map((entry) => entry.line).join("\n"))).filter((alert) => alert.Severity === "error")

	if (!errors.length) return

	const findings = errors
		.map((alert) => {
			// Vale numbers its lines against the added-line document.
			// The report maps each one back to the line the author sees in the replacement body.
			const source = added[alert.Line - 1]

			return `${alert.Check} at line ${source?.number ?? alert.Line}: ${alert.Message}`
		})
		.join("\n")

	throw new Error(`Vale rejected the GitHub prose the edit introduces:\n${findings}`)
}

/**
 * Replaces only the task list owned by the todo synchronization markers.
 */
export function replaceTaskBlock(body: string, taskList: string): string {
	const begin = body.indexOf(TODO_SYNC_BEGIN)
	const end = body.indexOf(TODO_SYNC_END)

	if (begin === -1 || end === -1 || end < begin) {
		throw new Error("The issue body does not contain a complete todo-sync marker block.")
	}

	return body.slice(0, begin + TODO_SYNC_BEGIN.length) + "\n" + taskList + "\n" + body.slice(end)
}

/**
 * Reports whether every task inside the owned marker block is checked.
 */
export function taskBlockIsComplete(body: string): boolean {
	const begin = body.indexOf(TODO_SYNC_BEGIN)
	const end = body.indexOf(TODO_SYNC_END)

	if (begin === -1 || end === -1 || end < begin) return false

	const block = body.slice(begin + TODO_SYNC_BEGIN.length, end)
	const tasks = block.match(/^- \[[ xX]\] .+$/gm) ?? []

	return tasks.length > 0 && tasks.every((task) => /^- \[[xX]\]/.test(task))
}

/**
 * Fetches one issue and normalizes its issue type to a name.
 */
export async function fetchGitHubIssue(
	repo: string,
	issueNumber: number,
	run: RunGitHub = runGitHub
): Promise<GitHubIssue> {
	const raw = parseJSONStrict<RawGitHubIssue>(
		await run(["issue", "view", String(issueNumber), "--repo", repo, "--json", ISSUE_FIELDS])
	)

	return { ...raw, issueType: raw.issueType?.name ?? null }
}

/**
 * Fetches one pull request.
 */
export async function fetchGitHubPullRequest(
	repo: string,
	pullRequestNumber: number,
	run: RunGitHub = runGitHub
): Promise<GitHubPullRequest> {
	return parseJSONStrict<GitHubPullRequest>(
		await run(["pr", "view", String(pullRequestNumber), "--repo", repo, "--json", PULL_REQUEST_FIELDS])
	)
}

/**
 * Writes the issue link shared by task-intake clients.
 */
export async function linkIssue(cwd: string, issueNumber: number): Promise<void> {
	const state = PathBuilder.from(cwd, ".claude", "state")

	await makeDirectories(state)
	await writeLocalTextFile(`${issueNumber}\n`, state("linked-issue"))
}

/**
 * The working tree a GitHub operation acts from.
 *
 * The server's own checkout is the default.
 * A caller in a worktree passes its checkout path.
 *
 * That path must share the server repository's `.git` directory.
 * A path in another repository is refused.
 */
export async function resolveCheckout(repoRoot: string, checkout?: string): Promise<string> {
	if (!checkout) return repoRoot

	if (!isAbsolute(checkout)) {
		throw new Error(`\`checkout\` must be an absolute path; received ${stringifyJSON(checkout)}.`)
	}

	const [expected, actual] = await Promise.all([gitCommonDirectory(repoRoot), gitCommonDirectory(checkout)])

	if (expected !== actual) {
		throw new Error(`${checkout} is not a checkout of the repository at ${repoRoot}.`)
	}

	return await workingTreeRoot(checkout)
}
