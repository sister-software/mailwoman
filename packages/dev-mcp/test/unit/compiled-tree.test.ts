/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, setTimestamps, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { assertCompiledFresh, checkCompiledFreshness } from "@mailwoman/dev-mcp/compiled-tree"
import { FINGERPRINTED_WORKSPACES } from "@mailwoman/dev-mcp/tree-fingerprint"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function checkout(): Promise<{ root: string; workspace: string }> {
	const root = String(fixtures.use(await temporaryDirectory("mwdev-compiled-")).path)

	const workspace = join(root, FINGERPRINTED_WORKSPACES[0])

	await makeDirectories(join(workspace, "out"))

	return { root, workspace }
}

async function touch(path: string, offsetMs: number): Promise<void> {
	const when = new Date(Date.now() + offsetMs)

	await setTimestamps(path, when, when)
}

describe("checkCompiledFreshness", () => {
	it("passes when the compiled output is newer than source", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", join(workspace, "thing.ts"))
		await writeLocalTextFile("export const x = 1\n", join(workspace, "out", "thing.js"))
		await touch(join(workspace, "thing.ts"), -60_000)
		await touch(join(workspace, "out", "thing.js"), 0)

		expect((await checkCompiledFreshness(root)).fresh).toBe(true)
	})

	it("refuses when source is newer, and says how to fix it", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 2\n", join(workspace, "thing.ts"))
		await writeLocalTextFile("export const x = 1\n", join(workspace, "out", "thing.js"))
		await touch(join(workspace, "out", "thing.js"), -60_000)
		await touch(join(workspace, "thing.ts"), 0)

		const freshness = await checkCompiledFreshness(root)

		expect(freshness.fresh).toBe(false)
		expect(freshness.reason).toContain("yarn compile")
		// It must say WHY this matters, not merely that it is stale: the gauntlet would report a verdict, not an error.
		expect(freshness.reason).toContain("grade code you have replaced")
		await expect(assertCompiledFresh(root)).rejects.toThrow(/yarn compile/)
	})

	it("distinguishes never-compiled from stale", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", join(workspace, "thing.ts"))

		expect((await checkCompiledFreshness(root)).reason).toContain("No compiled output found")
	})

	it("ignores emitted .d.ts on the source side, so a compile is not an edit", async () => {
		// Declaration output lands in out/ and is newer than everything by construction. Counting it as source would
		// make the guard permanently unsatisfiable.
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", join(workspace, "thing.ts"))
		await writeLocalTextFile("export const x = 1\n", join(workspace, "out", "thing.js"))
		await writeLocalTextFile("export declare const x: number\n", join(workspace, "out", "thing.d.ts"))
		await touch(join(workspace, "thing.ts"), -60_000)
		await touch(join(workspace, "out", "thing.js"), 0)
		await touch(join(workspace, "out", "thing.d.ts"), 30_000)

		expect((await checkCompiledFreshness(root)).fresh).toBe(true)
	})

	it.each(["thing.test.ts", "thing.test.tsx"])("ignores non-emitting colocated test source %s", async (testName) => {
		const { root, workspace } = await checkout()
		const source = join(workspace, "thing.ts")
		const compiled = join(workspace, "out", "thing.js")

		await writeLocalTextFile("export const x = 1\n", source)
		await writeLocalTextFile("export const x = 1\n", compiled)
		await writeLocalTextFile("export const testOnly = true\n", join(workspace, testName))
		await touch(source, -60_000)
		await touch(compiled, 0)
		await touch(join(workspace, testName), 30_000)

		const freshness = await checkCompiledFreshness(root)

		expect(freshness.fresh).toBe(true)
		expect(freshness.newestSource?.path).toBe(source)
	})

	it("ignores the workspace-root test tree excluded by tsconfig", async () => {
		const { root, workspace } = await checkout()
		const source = join(workspace, "thing.ts")
		const compiled = join(workspace, "out", "thing.js")
		const testHelper = join(workspace, "test", "unit", "helper.ts")

		await makeDirectories(join(workspace, "test", "unit"))
		await writeLocalTextFile("export const x = 1\n", source)
		await writeLocalTextFile("export const x = 1\n", compiled)
		await writeLocalTextFile("export const helper = true\n", testHelper)
		await touch(source, -60_000)
		await touch(compiled, 0)
		await touch(testHelper, 30_000)

		const freshness = await checkCompiledFreshness(root)

		expect(freshness.fresh).toBe(true)
		expect(freshness.newestSource?.path).toBe(source)
	})

	it.each(["debug-view/test/input-probe.ts", "thing.spec.ts", "contest/thing.ts"])(
		"keeps emitting source %s in the freshness comparison",
		async (sourcePath) => {
			const { root, workspace } = await checkout()
			const source = join(workspace, sourcePath)
			const compiled = join(workspace, "out", "thing.js")

			await makeDirectories(join(source, ".."))
			await writeLocalTextFile("export const x = 2\n", source)
			await writeLocalTextFile("export const x = 1\n", compiled)
			await touch(compiled, -60_000)
			await touch(source, 0)

			const freshness = await checkCompiledFreshness(root)

			expect(freshness.fresh).toBe(false)
			expect(freshness.newestSource?.path).toBe(source)
		}
	)
})
