#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PostToolUse hook: mirror the session's todo list into the linked GitHub issue's task list.
 *
 *   The plan an agent keeps in its head — or in a session todo list — dies with the session, and the operator's
 *   window into an autonomous session is GitHub, not the transcript. The `task-intake` skill creates an issue whose
 *   `## Task list` section carries a marker-delimited block; this hook rewrites that block on every `TodoWrite`, so
 *   the issue stays a live mirror of the working plan without the agent spending a turn on bookkeeping.
 *
 *   It NEVER blocks, on the same reasoning as `symbol-precheck.ts`: every failure path is silence, and the sync work
 *   itself runs in a DETACHED worker so the hook adds no latency to the turn. Three conditions check the worker, each
 *   making a no-op explicit rather than accidental:
 *
 *   - `.claude/state/linked-issue` must exist (the skill writes it; no link, no sync — most sessions have none).
 *   - The tool must be `TodoWrite`, whose payload carries the WHOLE list. `TaskCreate`/`TaskUpdate` carry deltas a
 *     stateless hook cannot fold into a list, so those sessions keep the issue current by hand at milestones.
 *   - The issue body must already carry both markers. The hook never invents structure in an issue it did not shape;
 *     absent markers mean the issue was not created by the skill, and rewriting it would clobber someone's prose.
 *
 *   Concurrency: rapid TodoWrite bursts atomically replace one payload file (last write wins). A worker holds a lock
 *   directory while it syncs and re-reads the payload after each pass. A worker that finds the lock waits for its turn,
 *   so a payload written during the lock holder's final pass still gets published.
 *
 *   Register in `.claude/settings.json` under `hooks.PostToolUse` with a `TodoWrite` matcher.
 */

import { pathExists, readLocalTextFile, readStandardInputJSON } from "@mailwoman/core/fs/readers"
import {
	makeDirectories,
	makeDirectoryExclusive,
	movePath,
	removePath,
	writeLocalJSONFile,
} from "@mailwoman/core/fs/writers"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { runFileSync, spawnProcess } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { join, resolvePath as resolve } from "path-ts"

/**
 * How many stabilization passes the worker makes before giving up. Each pass costs two `gh` round trips (~2s), so five
 * bounds one worker's `gh` calls at ~10s of background work. A waiting worker then reads the latest payload.
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

function stateDir(cwd: string): string {
	return join(cwd, ".claude", "state")
}

async function linkedIssue(cwd: string): Promise<number | null> {
	const path = join(stateDir(cwd), "linked-issue")

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
	// A malformed payload is a hook that does nothing, not a hook that throws into the turn.
	const payload = await readStandardInputJSON<Record<string, unknown>>().catch(() => null)

	if (payload?.tool_name !== "TodoWrite") return

	const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd()
	const issue = await linkedIssue(cwd)

	if (issue === null) return

	const todos = (payload.tool_input as { todos?: TodoItem[] } | undefined)?.todos

	if (!Array.isArray(todos)) return

	const dir = join(stateDir(cwd), "todo-sync")

	await makeDirectories(dir)
	const payloadPath = join(dir, "payload.json")
	const pendingPath = join(dir, `payload.${process.pid}.json`)

	await writeLocalJSONFile({ issue, todos }, pendingPath)
	await movePath(pendingPath, payloadPath)

	const child = spawnProcess(process.execPath, [import.meta.filename, "--worker", "--cwd", cwd], {
		detached: true,
		stdio: "ignore",
	})

	child.unref()
}

/**
 * Worker mode: lock, then sync the LATEST payload until it stops changing under us.
 */
type SyncIssue = (issue: number, todos: TodoItem[], dryRun: boolean) => void

type Delay = (milliseconds: number) => Promise<void>

const delay: Delay = (milliseconds) =>
	new Promise((done) => {
		setTimeout(done, milliseconds)
	})

async function acquireLock(lock: string, wait: Delay): Promise<boolean> {
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
	cwd: string,
	dryRun: boolean,
	sync: SyncIssue = syncIssue,
	wait: Delay = delay
): Promise<void> {
	const dir = join(stateDir(cwd), "todo-sync")
	const lock = join(dir, "lock")

	// A worker that loses the lock must wait for its own turn. Its payload can arrive after the lock holder's final read;
	// exiting here would leave that payload unpublished until another TodoWrite happened.
	if (!(await acquireLock(lock, wait))) return

	try {
		let previous = ""

		// Re-read until stable: a burst of TodoWrites overwrites payload.json, and publishing anything
		// but the final state would show the operator a stale list with a fresh timestamp.
		for (let pass = 0; pass < MAX_SYNC_PASSES; pass++) {
			const raw = await readLocalTextFile(join(dir, "payload.json"))

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

	// No markers, no write: this issue was not shaped by task-intake, and its body is someone's prose.
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
		// Silence on every failure path: a sync hook that can break a turn is a hook that gets switched off.
	}
}

// oxlint-disable-next-line sister-software/no-process-globals -- executable-entry detection has no project helper.
const entryPath = process.argv[1]

if (entryPath && import.meta.filename === resolve(entryPath)) {
	await main()
}
