#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mirror `TodoWrite` payloads into the marker-delimited task list of the linked GitHub issue. The hook
 *   runs asynchronously and does nothing unless the checkout has a linked issue, the tool is `TodoWrite`,
 *   and the issue contains both markers. A lock and replaceable payload file serialize concurrent updates.
 */

import { pathExists, readLocalTextFile, readStandardInputJSON } from "@mailwoman/core/fs/readers"
import {
	makeDirectories,
	makeDirectoryExclusive,
	movePath,
	removePath,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/json"
import { runFileSync, spawnProcess } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PathBuilder, type PathBuilderLike, resolvePath as resolve } from "path-ts"

/**
 * Maximum reads of the payload while waiting for it to stabilize.
 */
const MAX_SYNC_PASSES = 5
const LOCK_RETRY_MS = 100
const MAX_LOCK_ATTEMPTS = 300

const SYNC_BEGIN = "<!-- todo-sync:begin -->"
const SYNC_END = "<!-- todo-sync:end -->"

export interface TodoItem {
	content: string
	status: string
	activeForm?: string
}

function stateDir(cwd: PathBuilderLike): PathBuilder {
	return PathBuilder.from(cwd, ".claude", "state")
}

async function linkedIssue(cwd: PathBuilderLike): Promise<number | null> {
	const path = stateDir(cwd)("linked-issue")

	if (!(await pathExists(path))) return null

	const parsed = Number.parseInt((await readLocalTextFile(path)).trim(), 10)

	return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function renderTaskList(todos: TodoItem[]): string {
	const lines = todos.map((todo) => {
		if (todo.status === "completed") return `- [x] ${todo.content}`

		if (todo.status === "in_progress") return `- [ ] ${todo.content} — _in progress_`

		return `- [ ] ${todo.content}`
	})

	lines.push("", `_Mirrored from the session todo list. Last sync: ${new Date().toISOString()}_`)

	return lines.join("\n")
}

/**
 * Hook mode: stash the payload and hand off to a detached worker, so the turn never waits on `gh`.
 */
async function hookMain(): Promise<void> {
	// Ignore malformed hook input.
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)

	if (payload?.tool_name !== "TodoWrite") return

	const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd()
	const issue = await linkedIssue(cwd)

	if (issue === null) return

	const todos = (payload.tool_input as { todos?: TodoItem[] } | undefined)?.todos

	if (!Array.isArray(todos)) return

	const dir = stateDir(cwd)("todo-sync")

	await makeDirectories(dir)
	const payloadPath = dir("payload.json")
	const pendingPath = dir(`payload.${process.pid}.json`)

	await writeLocalJSONFile({ issue, todos }, pendingPath)
	await movePath(pendingPath, payloadPath)

	const child = spawnProcess(process.execPath, [import.meta.filename, "--worker", "--cwd", cwd], {
		detached: true,
		stdio: "ignore",
	})

	child.unref()
}

/**
 * Worker mode: lock, then sync the latest payload until it stops changing under us.
 */
type SyncIssue = (issue: number, todos: TodoItem[], dryRun: boolean) => void

type Delay = (milliseconds: number) => Promise<void>

const delay: Delay = (milliseconds) =>
	new Promise((done) => {
		setTimeout(done, milliseconds)
	})

async function acquireLock(lock: PathBuilder, wait: Delay): Promise<boolean> {
	for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
		try {
			await makeDirectoryExclusive(lock)

			return true
		} catch {
			await wait(LOCK_RETRY_MS)
		}
	}

	return false
}

export async function workerMain(
	cwd: PathBuilderLike,
	dryRun: boolean,
	sync: SyncIssue = syncIssue,
	wait: Delay = delay
): Promise<void> {
	const dir = stateDir(cwd)("todo-sync")
	const lock = dir("lock")

	// Wait for the lock so this worker's payload is not left unsynced.
	if (!(await acquireLock(lock, wait))) return

	try {
		let previous = ""

		// Re-read after each sync to publish the latest update in a burst.
		for (let pass = 0; pass < MAX_SYNC_PASSES; pass++) {
			const raw = await readLocalTextFile(dir("payload.json"))

			if (raw === previous) break

			previous = raw

			const payload = tryParsingJSON<{ issue: number; todos: TodoItem[] }>(raw)

			if (!payload) return

			sync(payload.issue, payload.todos, dryRun)
		}
	} finally {
		await removePath(lock)
	}
}

function syncIssue(issue: number, todos: TodoItem[], dryRun: boolean): void {
	const body = runFileSync("gh", ["issue", "view", String(issue), "--json", "body", "-q", ".body"], {
		encoding: "utf8",
		timeout: 30_000,
	})

	const begin = body.indexOf(SYNC_BEGIN)
	const end = body.indexOf(SYNC_END)

	// Leave issues without task-intake markers untouched.
	if (begin === -1 || end === -1 || end < begin) return

	const next = body.slice(0, begin + SYNC_BEGIN.length) + "\n" + renderTaskList(todos) + "\n" + body.slice(end)

	if (next === body) return

	if (dryRun) {
		process.stdout.write(next)

		return
	}

	runFileSync("gh", ["issue", "edit", String(issue), "--body-file", "-"], {
		input: next,
		timeout: 30_000,
	})
}

export interface GitHubUser {
	login: string
	name: string | null
}

export interface GitHubLabel {
	name: string
	color: string
}

export interface GitHubMilestone {
	title: string
	dueOn: string | null
}

export type GitHubIssueState = "OPEN" | "CLOSED"

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

/**
 * Fetch one issue with `gh` and normalize its issue type to a name.
 */
export async function fetchGitHubIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
	const body = runFileSync("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", ISSUE_FIELDS])

	const raw = parseJSONStrict<RawGitHubIssue>(body)

	return {
		...raw,
		issueType: raw.issueType?.name ?? null,
	}
}

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			worker: { type: "boolean", default: false },
			cwd: { type: "string" },
			"dry-run": { type: "boolean", default: false },
		},
	})

	try {
		await (values.worker ? workerMain(values.cwd ?? process.cwd(), values["dry-run"] ?? false) : hookMain())
	} catch {
		// Hook failures must not interrupt the caller's turn.
	}
}

// TODO: I don't believe this is true. Use node's `parseArgs`
// oxlint-disable-next-line sister-software/no-process-globals -- executable-entry detection has no project helper.
const entryPath = process.argv[1]

if (entryPath && import.meta.filename === resolve(entryPath)) {
	await main()
}
