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
 *   itself runs in a DETACHED worker so the hook adds no latency to the turn. Three conditions gate the worker, each
 *   making a no-op explicit rather than accidental:
 *
 *   - `.claude/state/linked-issue` must exist (the skill writes it; no link, no sync — most sessions have none).
 *   - The tool must be `TodoWrite`, whose payload carries the WHOLE list. `TaskCreate`/`TaskUpdate` carry deltas a
 *     stateless hook cannot fold into a list, so those sessions keep the issue current by hand at milestones.
 *   - The issue body must already carry both markers. The hook never invents structure in an issue it did not shape;
 *     absent markers mean the issue was not created by the skill, and rewriting it would clobber someone's prose.
 *
 *   Concurrency: rapid TodoWrite bursts overwrite one payload file (last write wins) and the worker holds a lock
 *   directory while it syncs, re-reading the payload after each pass until it is stable — so reordered workers cannot
 *   publish a stale list over a newer one.
 *
 *   Register in `.claude/settings.json` under `hooks.PostToolUse` with a `TodoWrite` matcher.
 */

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { tryParsingJSON } from "@mailwoman/core/objects"

const STDIN = 0

/**
 * How many stabilization passes the worker makes before giving up. Each pass costs two `gh` round trips (~2s), so five
 * bounds a pathological burst at ~10s of background work; a list still churning past that syncs on the NEXT TodoWrite,
 * which is the event that would have re-fired the hook anyway.
 */
const MAX_SYNC_PASSES = 5

const SYNC_BEGIN = "<!-- todo-sync:begin -->"
const SYNC_END = "<!-- todo-sync:end -->"

interface TodoItem {
	content: string
	status: string
	activeForm?: string
}

function stateDir(cwd: string): string {
	return join(cwd, ".claude", "state")
}

function linkedIssue(cwd: string): number | null {
	const path = join(stateDir(cwd), "linked-issue")

	if (!existsSync(path)) return null

	const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10)

	return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function renderTaskList(todos: TodoItem[]): string {
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
function hookMain(): void {
	const payload = tryParsingJSON<Record<string, unknown>>(readFileSync(STDIN, "utf8"))

	if (payload?.tool_name !== "TodoWrite") return

	const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd()
	const issue = linkedIssue(cwd)

	if (issue === null) return

	const todos = (payload.tool_input as { todos?: TodoItem[] } | undefined)?.todos

	if (!Array.isArray(todos) || !todos.length) return

	const dir = join(stateDir(cwd), "todo-sync")

	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "payload.json"), JSON.stringify({ issue, todos }))

	const child = spawn(process.execPath, [import.meta.filename, "--worker", "--cwd", cwd], {
		detached: true,
		stdio: "ignore",
	})

	child.unref()
}

/**
 * Worker mode: lock, then sync the LATEST payload until it stops changing under us.
 */
function workerMain(cwd: string, dryRun: boolean): void {
	const dir = join(stateDir(cwd), "todo-sync")
	const lock = join(dir, "lock")

	try {
		mkdirSync(lock)
	} catch {
		// Another worker holds the lock; it will re-read the payload we just wrote before releasing.
		return
	}

	try {
		let previous = ""

		// Re-read until stable: a burst of TodoWrites overwrites payload.json, and publishing anything
		// but the final state would show the operator a stale list with a fresh timestamp.
		for (let pass = 0; pass < MAX_SYNC_PASSES; pass++) {
			const raw = readFileSync(join(dir, "payload.json"), "utf8")

			if (raw === previous) break

			previous = raw

			const payload = tryParsingJSON<{ issue: number; todos: TodoItem[] }>(raw)

			if (!payload) return

			syncIssue(payload.issue, payload.todos, dryRun)
		}
	} finally {
		rmdirSync(lock)
	}
}

function syncIssue(issue: number, todos: TodoItem[], dryRun: boolean): void {
	const body = execFileSync("gh", ["issue", "view", String(issue), "--json", "body", "-q", ".body"], {
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

	execFileSync("gh", ["issue", "edit", String(issue), "--body-file", "-"], {
		input: next,
		timeout: 30_000,
	})
}

const { values } = parseArgs({
	options: {
		worker: { type: "boolean", default: false },
		cwd: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
})

try {
	if (values.worker) {
		workerMain(values.cwd ?? process.cwd(), values["dry-run"] ?? false)
	} else {
		hookMain()
	}
} catch {
	// Silence on every failure path: a sync hook that can break a turn is a hook that gets switched off.
}

process.exit(0)
