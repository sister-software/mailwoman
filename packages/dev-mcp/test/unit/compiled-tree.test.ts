/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The RULE these two functions apply is `@mailwoman/core/module/compiled-freshness` and is tested there. What is
 *   tested here is what this package adds: the workspace SET a spawned CLI loads, and the refusal.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, setTimestamps, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { assertCompiledFresh, checkSpawnedTreeFreshness } from "@mailwoman/dev-mcp/compiled-tree"
import { FINGERPRINTED_WORKSPACES } from "@mailwoman/dev-mcp/tree-fingerprint"
import type { PathBuilder, PathBuilderLike } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function checkout(): Promise<{ root: PathBuilder; workspace: PathBuilder }> {
	const root = fixtures.use(await temporaryDirectory("mwdev-compiled-")).path
	const workspace = root(FINGERPRINTED_WORKSPACES[0])

	await makeDirectories(workspace("out"))

	return { root, workspace }
}

async function touch(path: PathBuilderLike, offsetMs: number): Promise<void> {
	const when = new Date(Date.now() + offsetMs)

	await setTimestamps(path, when, when)
}

describe("checkSpawnedTreeFreshness", () => {
	it("reads the workspaces a spawned CLI loads", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", workspace("thing.ts"))
		await writeLocalTextFile("export const x = 1\n", workspace("out", "thing.js"))
		await touch(workspace("thing.ts"), -60_000)
		await touch(workspace("out", "thing.js"), 0)

		const freshness = await checkSpawnedTreeFreshness(root)

		expect(freshness.fresh).toBe(true)
		expect(freshness.newestSource?.path).toBe(workspace("thing.ts").toString())
	})

	it("sees a stale source in a workspace OTHER than the first", async () => {
		// The set is the point of this wrapper.
		// A check that read only `packages/mailwoman` would answer fresh while the resolver it loads was stale.
		const { root } = await checkout()
		const other = root(FINGERPRINTED_WORKSPACES[4])

		await makeDirectories(other("out"))
		await writeLocalTextFile("export const x = 2\n", other("thing.ts"))
		await writeLocalTextFile("export const x = 1\n", other("out", "thing.js"))
		await touch(other("out", "thing.js"), -60_000)
		await touch(other("thing.ts"), 0)

		const freshness = await checkSpawnedTreeFreshness(root)

		expect(freshness.fresh).toBe(false)
		expect(freshness.newestSource?.path).toBe(other("thing.ts").toString())
	})
})

describe("assertCompiledFresh", () => {
	it("throws, and says why a warning would not do", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 2\n", workspace("thing.ts"))
		await writeLocalTextFile("export const x = 1\n", workspace("out", "thing.js"))
		await touch(workspace("out", "thing.js"), -60_000)
		await touch(workspace("thing.ts"), 0)

		// The failure mode is silence, so the message has to carry the consequence rather than only the state.
		await expect(assertCompiledFresh(root)).rejects.toThrow(/yarn compile/)
		await expect(assertCompiledFresh(root)).rejects.toThrow(/grade code you have replaced/)
	})

	it("returns the reading when the tree is fresh", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", workspace("thing.ts"))
		await writeLocalTextFile("export const x = 1\n", workspace("out", "thing.js"))
		await touch(workspace("thing.ts"), -60_000)
		await touch(workspace("out", "thing.js"), 0)

		expect((await assertCompiledFresh(root)).fresh).toBe(true)
	})
})
