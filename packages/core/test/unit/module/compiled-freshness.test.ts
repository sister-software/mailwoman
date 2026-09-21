/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, setTimestamps, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { checkCompiledFreshness } from "@mailwoman/core/module/compiled-freshness"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * The one workspace these fixtures build. A caller names its own set, so the tests name one
 * rather than importing a list from a package that happens to have one.
 */
const WORKSPACE = "packages/probe"

async function checkout(): Promise<{ root: string; workspace: string }> {
	const root = String(fixtures.use(await temporaryDirectory("mw-compiled-")).path)
	const workspace = join(root, WORKSPACE)

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

		expect((await checkCompiledFreshness(root, [WORKSPACE])).fresh).toBe(true)
	})

	it("refuses when source is newer, and says how to fix it", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 2\n", join(workspace, "thing.ts"))
		await writeLocalTextFile("export const x = 1\n", join(workspace, "out", "thing.js"))
		await touch(join(workspace, "out", "thing.js"), -60_000)
		await touch(join(workspace, "thing.ts"), 0)

		const freshness = await checkCompiledFreshness(root, [WORKSPACE])

		expect(freshness.fresh).toBe(false)
		expect(freshness.reason).toContain("yarn compile")
		// Both endpoints are named, because "stale" without them sends the reader looking for the file themselves.
		expect(freshness.reason).toContain(join(workspace, "thing.ts"))
		expect(freshness.reason).toContain(join(workspace, "out", "thing.js"))
	})

	it("distinguishes never-compiled from stale", async () => {
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", join(workspace, "thing.ts"))

		expect((await checkCompiledFreshness(root, [WORKSPACE])).reason).toContain("No compiled output found")
	})

	it("reads the newest EMITTED FILE rather than the out/ directory's own mtime", async () => {
		// `tsc` overwrites in place, and a directory's mtime moves only when an entry is added
		// or removed. A check anchored on the directory therefore never advances on a recompile.
		// Measured on `packages/core`, the directory read 2026-09-14T17:36:04Z against a newest emit of
		// 2026-09-19T02:33:12Z, so the battery's own copy of this warned after every successful compile.
		const { root, workspace } = await checkout()
		const source = join(workspace, "thing.ts")
		const compiled = join(workspace, "out", "thing.js")

		await writeLocalTextFile("export const x = 1\n", compiled)
		await writeLocalTextFile("export const x = 1\n", source)
		// The directory is left far in the past. Only the file inside it is current.
		await touch(join(workspace, "out"), -600_000)
		await touch(source, -60_000)
		await touch(compiled, 0)

		expect((await checkCompiledFreshness(root, [WORKSPACE])).fresh).toBe(true)
	})

	it("ignores emitted .d.ts on the source side, so a compile is not an edit", async () => {
		// Declaration output lands in out/ and is newer than everything by construction.
		// Counting it as source would make the check permanently unsatisfiable.
		const { root, workspace } = await checkout()

		await writeLocalTextFile("export const x = 1\n", join(workspace, "thing.ts"))
		await writeLocalTextFile("export const x = 1\n", join(workspace, "out", "thing.js"))
		await writeLocalTextFile("export declare const x: number\n", join(workspace, "out", "thing.d.ts"))
		await touch(join(workspace, "thing.ts"), -60_000)
		await touch(join(workspace, "out", "thing.js"), 0)
		await touch(join(workspace, "out", "thing.d.ts"), 30_000)

		expect((await checkCompiledFreshness(root, [WORKSPACE])).fresh).toBe(true)
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

		const freshness = await checkCompiledFreshness(root, [WORKSPACE])

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

		const freshness = await checkCompiledFreshness(root, [WORKSPACE])

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

			const freshness = await checkCompiledFreshness(root, [WORKSPACE])

			expect(freshness.fresh).toBe(false)
			expect(freshness.newestSource?.path).toBe(source)
		}
	)

	it("takes the newest source and emit ACROSS the named workspaces", async () => {
		// A caller that names too few workspaces buys a `fresh` it has not earned, so the walk must span the set.
		const root = String(fixtures.use(await temporaryDirectory("mw-compiled-multi-")).path)
		const first = join(root, "packages/one")
		const second = join(root, "packages/two")

		await makeDirectories(join(first, "out"))
		await makeDirectories(join(second, "out"))
		await writeLocalTextFile("export const x = 1\n", join(first, "a.ts"))
		await writeLocalTextFile("export const x = 1\n", join(first, "out", "a.js"))
		await writeLocalTextFile("export const y = 1\n", join(second, "b.ts"))
		await writeLocalTextFile("export const y = 1\n", join(second, "out", "b.js"))
		await touch(join(first, "a.ts"), -60_000)
		await touch(join(first, "out", "a.js"), 0)
		await touch(join(second, "out", "b.js"), -60_000)
		await touch(join(second, "b.ts"), 30_000)

		expect((await checkCompiledFreshness(root, ["packages/one"])).fresh).toBe(true)

		const both = await checkCompiledFreshness(root, ["packages/one", "packages/two"])

		expect(both.fresh).toBe(false)
		expect(both.newestSource?.path).toBe(join(second, "b.ts"))
	})
})
