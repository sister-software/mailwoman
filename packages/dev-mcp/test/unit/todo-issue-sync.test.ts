/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, makeDirectoryExclusive, removePath, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { renderTaskList, workerMain, type TodoItem } from "@mailwoman/dev-mcp/hooks/todo-issue-sync"
import { join } from "@mailwoman/platform/path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Scratch directories for this file's fixtures, removed after each test — the lock and payload paths are per-test.
 */
let fixtures = new AsyncDisposableStack()

async function fixture(): Promise<{ cwd: string; dir: string; lock: string; payload: string }> {
	const cwd = fixtures.use(await temporaryDirectory("mw-todo-sync-")).path
	const dir = join(cwd, ".claude", "state", "todo-sync")

	await makeDirectories(dir)

	return { cwd, dir, lock: join(dir, "lock"), payload: join(dir, "payload.json") }
}

afterEach(async () => {
	await fixtures.disposeAsync()
	fixtures = new AsyncDisposableStack()
})

describe("todo issue sync", () => {
	it("renders an empty complete list instead of retaining stale tasks", () => {
		expect(renderTaskList([])).toMatch(/^\n_Mirrored from the session todo list\./)
	})

	it("publishes a payload that arrives while another worker holds the lock", async () => {
		const { cwd, lock, payload } = await fixture()
		const stale: TodoItem[] = [{ content: "Old task", status: "pending" }]
		const latest: TodoItem[] = [{ content: "Latest task", status: "in_progress" }]
		const published: TodoItem[][] = []

		await writeLocalJSONFile({ issue: 1849, todos: stale }, payload)
		await makeDirectoryExclusive(lock)

		let waits = 0

		await workerMain(
			cwd,
			false,
			(_issue, todos) => {
				published.push(todos)
			},
			async () => {
				waits++
				await writeLocalJSONFile({ issue: 1849, todos: latest }, payload)
				await removePath(lock)
			}
		)

		expect(waits).toBe(1)
		expect(published).toEqual([latest])
	})
})
