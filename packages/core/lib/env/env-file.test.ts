/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A worktree reads the main checkout's `.env` through its `.git` pointer, and its own `.env` wins.
 */

import { describe, expect, it } from "vitest"

import { resolveEnvFile } from "#env/env-file"
import { temporaryDirectory, type TemporaryDirectory } from "#fs/temporary"
import { makeDirectories, removePath, writeLocalTextFile } from "#fs/writers"

/**
 * A main checkout with a `.env` and one worktree whose `.git` file points back at it, laid out as git does.
 */
async function repository(root: TemporaryDirectory): Promise<{ main: string; worktree: string }> {
	const main = root.path("main").toString()
	const worktree = root.path("worktrees", "feature").toString()
	const worktreeGitDirectory = root.path("main", ".git", "worktrees", "feature").toString()

	await makeDirectories(worktreeGitDirectory, worktree)
	await writeLocalTextFile("MAILWOMAN_DATA_ROOT=/data\n", main, ".env")
	await writeLocalTextFile(`gitdir: ${worktreeGitDirectory}\n`, worktree, ".git")
	await writeLocalTextFile("../..\n", worktreeGitDirectory, "commondir")

	return { main, worktree }
}

describe("resolveEnvFile", () => {
	it("reads the main checkout's .env from a worktree through its .git pointer", async () => {
		await using root = await temporaryDirectory("mw-env-file-")
		const { main, worktree } = await repository(root)

		expect(resolveEnvFile(worktree)).toBe(`${main}/.env`)
	})

	it("reads the main checkout's own .env from the main checkout", async () => {
		await using root = await temporaryDirectory("mw-env-file-")
		const { main } = await repository(root)

		expect(resolveEnvFile(main)).toBe(`${main}/.env`)
	})

	it("prefers a .env beside the worktree over the main checkout's", async () => {
		await using root = await temporaryDirectory("mw-env-file-")
		const { worktree } = await repository(root)

		await writeLocalTextFile("MAILWOMAN_DATA_ROOT=/elsewhere\n", worktree, ".env")

		expect(resolveEnvFile(worktree)).toBe(`${worktree}/.env`)
	})

	it("answers null for a directory with no .env and no .git pointer", async () => {
		await using root = await temporaryDirectory("mw-env-file-")
		const { worktree } = await repository(root)

		await removePath(`${worktree}/.git`)

		expect(resolveEnvFile(worktree)).toBeNull()
	})

	it("answers null for a worktree whose main checkout has no .env", async () => {
		await using root = await temporaryDirectory("mw-env-file-")
		const { main, worktree } = await repository(root)

		await removePath(`${main}/.env`)

		expect(resolveEnvFile(worktree)).toBeNull()
	})
})
