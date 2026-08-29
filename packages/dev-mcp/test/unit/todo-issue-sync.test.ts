/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { renderTaskList, workerMain, type TodoItem } from "@mailwoman/dev-mcp/hooks/todo-issue-sync"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { afterEach, describe, expect, it } from "vitest"

const fixtures: string[] = []

function fixture(): { cwd: string; dir: string; lock: string; payload: string } {
	const cwd = mkdtempSync(join(tmpdir(), "mw-todo-sync-"))
	const dir = join(cwd, ".claude", "state", "todo-sync")

	mkdirSync(dir, { recursive: true })
	fixtures.push(cwd)

	return { cwd, dir, lock: join(dir, "lock"), payload: join(dir, "payload.json") }
}

afterEach(() => {
	for (const path of fixtures.splice(0)) {
		rmSync(path, { recursive: true, force: true })
	}
})

describe("todo issue sync", () => {
	it("renders an empty complete list instead of retaining stale tasks", () => {
		expect(renderTaskList([])).toMatch(/^\n_Mirrored from the session todo list\./)
	})

	it("publishes a payload that arrives while another worker holds the lock", async () => {
		const { cwd, lock, payload } = fixture()
		const stale: TodoItem[] = [{ content: "Old task", status: "pending" }]
		const latest: TodoItem[] = [{ content: "Latest task", status: "in_progress" }]
		const published: TodoItem[][] = []

		writeFileSync(payload, JSON.stringify({ issue: 1849, todos: stale }))
		mkdirSync(lock)

		let waits = 0

		await workerMain(
			cwd,
			false,
			(_issue, todos) => {
				published.push(todos)
			},
			async () => {
				waits++
				writeFileSync(payload, JSON.stringify({ issue: 1849, todos: latest }))
				rmSync(lock, { recursive: true })
			}
		)

		expect(waits).toBe(1)
		expect(published).toEqual([latest])
	})
})
